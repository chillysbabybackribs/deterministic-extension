import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the model client, the fat-tool execution, and the extraction store so we
// can drive the loop deterministically.
vi.mock("../../model/anthropicToolClient", () => ({
  callAnthropicMessage: vi.fn(),
  streamAnthropicMessage: vi.fn(),
  extractText: (blocks: Array<{ type: string; text?: string }>) =>
    blocks.filter((b) => b.type === "text").map((b) => b.text).join("")
}));
vi.mock("./executePlan", () => ({ executePlan: vi.fn() }));
vi.mock("../../tools/fat", () => ({ clearTask: vi.fn(() => Promise.resolve()) }));
vi.mock("../../tools/elementOverlay", () => ({ hideAllActionableOverlays: vi.fn(() => Promise.resolve()) }));
// Fast-path defaults to "skip" so non-interaction tests behave as before; tests
// that exercise the inversion override it per-case.
vi.mock("./interactionFastPath", () => ({ runInteractionFastPath: vi.fn(async () => ({ kind: "skip" })) }));
vi.mock("./pagePlanningContext", () => ({ buildPagePlanningContext: vi.fn(async () => undefined) }));

import { callAnthropicMessage, streamAnthropicMessage } from "../../model/anthropicToolClient";
import { executePlan } from "./executePlan";
import { hideAllActionableOverlays } from "../../tools/elementOverlay";
import { runInteractionFastPath } from "./interactionFastPath";
import { buildPagePlanningContext } from "./pagePlanningContext";
import { runPipeline } from "./pipelineRunner";
import { DEFAULT_APP_SETTINGS } from "../../settings/settingsStore";

const mockModel = vi.mocked(callAnthropicMessage);
const mockStream = vi.mocked(streamAnthropicMessage);
const mockExec = vi.mocked(executePlan);
const mockFastPath = vi.mocked(runInteractionFastPath);
const mockPagePlanning = vi.mocked(buildPagePlanningContext);
const mockHide = vi.mocked(hideAllActionableOverlays);

function msg(text: string) {
  return { id: "m", type: "message" as const, role: "assistant" as const, model: "x", content: [{ type: "text" as const, text }] };
}

const settings = {
  ...DEFAULT_APP_SETTINGS,
  provider: { ...DEFAULT_APP_SETTINGS.provider, apiKey: "sk-ant-test" }
};

afterEach(() => vi.clearAllMocks());
// vi.clearAllMocks() wipes implementations too; restore defaults each test:
//  - fast-path: "skip" so non-interaction tests behave as before.
//  - model: a trailing default of a "none" follow-up, so the post-answer
//    follow-up call (which runs after synthesis on any non-blocked answer)
//    resolves cleanly without each test having to enumerate it. The
//    mockResolvedValueOnce chains take precedence for PLAN/GATE/SYNTHESIZE.
beforeEach(() => {
  mockFastPath.mockResolvedValue({ kind: "skip" });
  mockPagePlanning.mockResolvedValue(undefined);
  // Trailing default for callAnthropicMessage = a "none" follow-up, so the
  // post-answer follow-up call (after any non-blocked answer) resolves cleanly.
  // mockResolvedValueOnce chains for PLAN/GATE/SYNTHESIZE take precedence.
  mockModel.mockResolvedValue(msg(JSON.stringify({ kind: "none", text: "" })));
  // Streaming synthesis (used when onAnswerDelta is provided) emits its text via
  // onTextDelta and returns the same content. Default echoes a fixed answer;
  // tests that need specific synthesis text override with mockResolvedValueOnce.
  mockStream.mockImplementation(async (a: { onTextDelta?: (d: string) => void }) => {
    a.onTextDelta?.("The page is X.");
    return msg("The page is X.");
  });
});

describe("runPipeline loop", () => {
  it("plan -> execute -> gate(synthesize) -> answer in one iteration", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ reason: "understand", steps: [{ tool: "understand_page", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "page is X", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Final: the page is X.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{ tool: "understand_page", summary: "page summary", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({ userMessage: "what is this page", settings });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("the page is X");
    expect(mockExec).toHaveBeenCalledTimes(1);
    // PLAN + GATE + SYNTHESIZE + FOLLOW-UP = 4 model calls
    expect(mockModel).toHaveBeenCalledTimes(4);
    // understand_page runs the per-page overlay pass, so turn-end cleanup clears it.
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("threads activeWorkingFile through to the planner prompt (guards the capture-drop bug)", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ reason: "query the file", steps: [{ tool: "query_file", args: { query: "revenue" } }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "found it", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Revenue was 100.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{ tool: "query_file", summary: "row matched", status: "success", warnings: [], args: {} }]);

    await runPipeline({
      userMessage: "what was the revenue",
      settings,
      activeWorkingFile: { fileName: "q3.csv", sourceType: "file", sourceKind: "csv", unitCount: 42 }
    });

    // The PLAN call is the first model call; its message must mention the file.
    const planMessages = mockModel.mock.calls[0][0].messages;
    const planText = JSON.stringify(planMessages);
    expect(planText).toContain("q3.csv");
    expect(planText).toContain("query_file");

    // executePlan received the userMessage context so query_file anchors to the prompt.
    expect(mockExec.mock.calls[0][2]).toMatchObject({ userMessage: "what was the revenue" });

    // The SYNTHESIZE call (3rd model call: PLAN, GATE, SYNTHESIZE) is instructed
    // to cite the working file's locations and add a Sources list.
    const synthText = JSON.stringify(mockModel.mock.calls[2][0].messages);
    expect(synthText).toContain("q3.csv");
    expect(synthText.toLowerCase()).toContain("sources");
  });

  it("tears the actionable overlay down once at the end of a turn that acted on the page", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 5 } }] } }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "clicked", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Clicked it.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{ tool: "act_on_page", summary: "clicked #5", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({ userMessage: "click element 5", settings });
    expect(r.ok).toBe(true);
    // The overlay (left painted through the whole response) is torn down exactly
    // once, after synthesis, at turn end.
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("fast-path 'fired' short-circuits the turn with NO model and NO plan", async () => {
    mockFastPath.mockResolvedValueOnce({
      kind: "fired",
      answer: "Scrolled to \"Pricing\".",
      capture: { elements: [] } as never,
      winner: {} as never
    });
    const deltas: string[] = [];
    const r = await runPipeline({ userMessage: "scroll to the pricing link", settings, onAnswerDelta: (d) => deltas.push(d) });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("Scrolled to");
    // Zero model calls (no plan, no gate, no synthesis) — pure deterministic.
    expect(mockModel).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(deltas.join("")).toContain("Scrolled to");
    // Overlay was painted by the fast-path and torn down at turn end.
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("fast-path 'escalate' seeds the first plan with the candidate shortlist (overlayIndex hint)", async () => {
    mockFastPath.mockResolvedValueOnce({
      kind: "escalate",
      reason: "exact match #5 for a click — mutation is model-authorized",
      capture: { elements: [] } as never,
      hint: "Actionable elements matching \"sign in\" (choose the right one by overlayIndex):\n#5 button \"Sign in\""
    });
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 5 } }] } }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "clicked", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Clicked Sign in.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{ tool: "act_on_page", summary: "clicked #5", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({ userMessage: "click the sign in button", settings });
    expect(r.ok).toBe(true);
    // The planner prompt (first model call) must contain the shortlist hint.
    const firstPlanPrompt = JSON.stringify(mockModel.mock.calls[0]?.[0]);
    expect(firstPlanPrompt).toContain("matching");
    expect(firstPlanPrompt).toContain("#5 button");
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("passes the pre-planning page corpus and active UI capture into the first planner prompt", async () => {
    mockPagePlanning.mockResolvedValueOnce({
      capture: { elements: [] } as never,
      plannerText: "Pre-planning page corpus from deterministic overlay.\nDraft workflow JSON steps:\n[{\"tool\":\"act_on_page\"}]",
      draftSteps: [{ tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 7 } }] } }],
      logSummary: "12 actionable element(s) mapped; draft act_on_page."
    });
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 7 } }] } }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "clicked", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Clicked it.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{ tool: "act_on_page", summary: "clicked #7", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({
      userMessage: "click the selected button",
      settings,
      activeCaptureContext: "Active captured UI context for this user request.\nselector: #selected"
    });

    expect(r.ok).toBe(true);
    const firstPlanPrompt = JSON.stringify(mockModel.mock.calls[0]?.[0]);
    expect(firstPlanPrompt).toContain("Pre-planning page corpus");
    expect(firstPlanPrompt).toContain("Draft workflow JSON steps");
    expect(firstPlanPrompt).toContain("Active captured UI context");
    expect(firstPlanPrompt).toContain("#selected");
    // The prefetched overlay map from pre-planning is handed to act_on_page.
    expect(mockExec.mock.calls[0][2]).toMatchObject({ prefetchedActionableMap: { elements: [] } });
    expect(mockHide).toHaveBeenCalledTimes(1);
  });

  it("auto-resumes concrete deferred page steps without a second planner call", async () => {
    const deferredUnderstand = { tool: "understand_page" as const, args: {} };
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({
        steps: [
          { tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 5 } }] } },
          deferredUnderstand
        ]
      }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "clicked then understood changed page", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("The page changed after the click.")); // SYNTHESIZE
    mockExec
      .mockResolvedValueOnce([{
        tool: "act_on_page",
        summary: "clicked #5",
        status: "success",
        warnings: [],
        args: { steps: [{ action: "click", target: { overlayIndex: 5 } }] },
        deferred: {
          boundary: "post_action",
          reason: "Deferred 1 planned page-dependent step(s).",
          steps: [deferredUnderstand]
        }
      }])
      .mockResolvedValueOnce([{
        tool: "understand_page",
        summary: "new page summary",
        status: "success",
        warnings: [],
        args: {}
      }]);

    const r = await runPipeline({ userMessage: "click a navigation link, then tell me what changed", settings });

    expect(r.ok).toBe(true);
    expect(r.answer).toContain("changed");
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[1][1]).toMatchObject({ steps: [deferredUnderstand] });
    // PLAN + GATE + SYNTHESIZE + FOLLOW-UP. No second PLAN call is needed.
    expect(mockModel).toHaveBeenCalledTimes(4);
  });

  it("adds deterministic post-action understanding when the planner under-plans a what-changed request", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({
        steps: [
          { tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 8 } }] } }
        ]
      }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "clicked then read new state", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("The page changed after the click.")); // SYNTHESIZE
    mockExec
      .mockResolvedValueOnce([{
        tool: "act_on_page",
        summary: "clicked #8",
        status: "success",
        warnings: [],
        args: { steps: [{ action: "click", target: { overlayIndex: 8 } }] }
      }])
      .mockResolvedValueOnce([{
        tool: "understand_page",
        summary: "post-click page summary",
        status: "success",
        warnings: [],
        args: {}
      }]);

    const r = await runPipeline({ userMessage: "Click a navigation link on this page, then tell me what changed", settings });

    expect(r.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[1][1]).toMatchObject({
      reason: "deterministic post-action page report",
      steps: [{ tool: "understand_page", args: {} }]
    });
    const gatePrompt = JSON.stringify(mockModel.mock.calls[1]?.[0]);
    expect(gatePrompt).toContain("clicked #8");
    expect(gatePrompt).toContain("post-click page summary");
    // PLAN + GATE + SYNTHESIZE + FOLLOW-UP. Still no second PLAN call.
    expect(mockModel).toHaveBeenCalledTimes(4);
  });

  it("loops: gate replan triggers a second plan+execute", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "search_web", args: { query: "a" } }] }))) // PLAN 1
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "replan", accumulator: "partial", missing: "need more" }))) // GATE 1
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "search_web", args: { query: "b" } }] }))) // PLAN 2
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "complete", missing: "" }))) // GATE 2
      .mockResolvedValueOnce(msg("Done.")); // SYNTHESIZE
    mockExec
      .mockResolvedValueOnce([{ tool: "search_web", summary: "round1", status: "success", warnings: [], args: { query: "a" } }])
      .mockResolvedValueOnce([{ tool: "search_web", summary: "round2", status: "success", warnings: [], args: { query: "b" } }]);

    const r = await runPipeline({ userMessage: "research X", settings });
    expect(r.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("grep recovery: gate grep -> inline grep execute -> synthesize", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "capture_network", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "grep", accumulator: "have endpoints", missing: "auth header", grepQuery: "authorization" }))) // GATE
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "have endpoints + auth", missing: "" }))) // GATE after grep
      .mockResolvedValueOnce(msg("Auth is bearer.")); // SYNTHESIZE
    mockExec
      .mockResolvedValueOnce([{ tool: "capture_network", summary: "endpoints", status: "success", warnings: [], args: {} }]) // plan execute
      .mockResolvedValueOnce([{ tool: "grep_extractions", summary: "found authorization header", status: "grep", warnings: [], args: { query: "authorization" } }]); // inline grep

    const r = await runPipeline({ userMessage: "what auth does this api use", settings });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("bearer");
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("empty plan -> synthesize directly without executing", async () => {
    mockModel
      .mockResolvedValueOnce(msg("I cannot make a plan.")) // PLAN (no JSON -> 0 steps)
      .mockResolvedValueOnce(msg("Direct answer.")); // SYNTHESIZE
    const r = await runPipeline({ userMessage: "hello", settings });
    expect(r.ok).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("appends a follow-up suggestion after the answer when the follow-up step fires", async () => {
    // PLAN + GATE go through callAnthropicMessage; SYNTHESIZE streams (onAnswerDelta
    // is provided) via the stream mock; the FOLLOW-UP is the next callAnthropicMessage.
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "understand_page", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "page is X", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg(JSON.stringify({ kind: "suggestion", text: "I could capture its network traffic next — want me to?" }))); // FOLLOW-UP
    mockExec.mockResolvedValueOnce([{ tool: "understand_page", summary: "page summary", status: "success", warnings: [], args: {} }]);

    const deltas: string[] = [];
    const r = await runPipeline({ userMessage: "what is this page", settings, onAnswerDelta: (d) => deltas.push(d) });
    expect(r.ok).toBe(true);
    expect(r.answer).toContain("The page is X.");
    expect(r.answer).toContain("capture its network traffic");
    // The suggestion is streamed as a continuation delta, separated from the answer.
    expect(deltas.join("")).toContain("capture its network traffic");
  });

  it("proactively continues when the follow-up returns 'proceed', appending the next step's answer", async () => {
    mockModel
      // ROUND 1: PLAN, GATE, then FOLLOW-UP = proceed
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "understand_page", args: {} }] }))) // PLAN 1
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "page is a dashboard", missing: "" }))) // GATE 1
      .mockResolvedValueOnce(msg("It's a dashboard.")) // SYNTHESIZE 1 (no onAnswerDelta -> callAnthropicMessage)
      .mockResolvedValueOnce(msg(JSON.stringify({ kind: "proceed", text: "Capture this page's network traffic and summarize the API." }))) // FOLLOW-UP 1 = proceed
      // ROUND 2: PLAN, GATE, SYNTHESIZE, then FOLLOW-UP = none
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "capture_network", args: {} }] }))) // PLAN 2
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "dashboard + endpoints", missing: "" }))) // GATE 2
      .mockResolvedValueOnce(msg("It calls /api/usage.")) // SYNTHESIZE 2
      .mockResolvedValueOnce(msg(JSON.stringify({ kind: "none", text: "" }))); // FOLLOW-UP 2 = none
    mockExec
      .mockResolvedValueOnce([{ tool: "understand_page", summary: "dashboard summary", status: "success", warnings: [], args: {} }])
      .mockResolvedValueOnce([{ tool: "capture_network", summary: "endpoints: /api/usage", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({ userMessage: "what is this page", settings });
    expect(r.ok).toBe(true);
    // Both round answers are present, the second appended after the first.
    expect(r.answer).toContain("It's a dashboard.");
    expect(r.answer).toContain("It calls /api/usage.");
    expect(r.answer.indexOf("dashboard")).toBeLessThan(r.answer.indexOf("/api/usage"));
    // Two plan+execute rounds ran (proactive continuation).
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("caps proactive continuations: a 'proceed' past the cap does not loop forever", async () => {
    // Every follow-up says proceed; the cap (MAX_PROACTIVE_ROUNDS=2) must stop it.
    // Provide enough PLAN/GATE/SYNTH/FOLLOWUP responses; default trailing mock
    // returns a proceed too, so only the cap can end it.
    mockModel.mockResolvedValue(msg(JSON.stringify({ kind: "proceed", text: "do more" })));
    // Each round consumes PLAN, GATE, SYNTH, FOLLOWUP from the default proceed is
    // not valid JSON for plan/gate, so they parse to empty/synthesize-fallback —
    // which still drives the loop deterministically toward the cap.
    mockExec.mockResolvedValue([{ tool: "understand_page", summary: "s", status: "success", warnings: [], args: {} }]);

    const r = await runPipeline({ userMessage: "go", settings });
    expect(r.ok).toBe(true);
    // Rounds are bounded: initial + at most MAX_PROACTIVE_ROUNDS(2) = 3 synthesis
    // passes worth of execution at most; it must terminate, not hang.
    expect(mockExec.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("grounds an engine question with authored engine knowledge in the synthesis prompt", async () => {
    mockModel
      .mockResolvedValueOnce(msg("I cannot make a plan.")) // PLAN -> empty (conversational)
      .mockResolvedValueOnce(msg("The engine reads response bodies your session can see.")); // SYNTHESIZE
    const r = await runPipeline({
      userMessage: "Explain the background engine and why this task was limited — what would it let you do here?",
      settings,
      history: [
        { role: "user", content: "go deep into the backend of this web app" },
        { role: "assistant", content: "Backend analysis... response bodies were CSP-blocked." },
        { role: "user", content: "Explain the background engine and why this task was limited — what would it let you do here?" }
      ]
    });
    expect(r.ok).toBe(true);
    // The synthesis call (2nd model call) must carry the authoritative engine facts.
    const synthPrompt = JSON.stringify(mockModel.mock.calls[1]?.[0]);
    expect(synthPrompt).toContain("Authoritative facts about the optional background engine");
    expect(synthPrompt).toContain("Manifest V3");
    // And the backend-mapping entry, retrieved via the ORIGINAL prompt.
    expect(synthPrompt).toContain("mapping a web app");
  });

  it("surfaces a capability gap raised by a step onto the response", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "capture_network", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg(JSON.stringify({ decision: "synthesize", accumulator: "endpoints only", missing: "" }))) // GATE
      .mockResolvedValueOnce(msg("Endpoints captured; bodies were blocked.")); // SYNTHESIZE (default follow-up = none)
    mockExec.mockResolvedValueOnce([{
      tool: "capture_network",
      summary: "inventory; bodies CSP-blocked",
      status: "partial",
      warnings: [],
      args: {},
      meta: { capabilityGap: { capability: "full_network_capture", reason: "This page blocks in-browser capture of response bodies." } }
    }]);

    const r = await runPipeline({ userMessage: "capture the api calls", settings });
    expect(r.ok).toBe(true);
    expect(r.capabilityGap?.capability).toBe("full_network_capture");
    expect(r.capabilityGap?.reason).toContain("response bodies");
  });

  it("does NOT run the follow-up step on a blocked answer", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "capture_network", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg("Could not capture; deep capture unavailable.")); // SYNTHESIZE
    mockExec.mockResolvedValueOnce([{
      tool: "capture_network", summary: "blocked", status: "partial", warnings: [], args: {},
      meta: { blocked: true, blockedReason: "Deep network capture is unavailable." }
    }]);

    const r = await runPipeline({ userMessage: "capture the api calls", settings });
    expect(r.ok).toBe(true);
    // PLAN + SYNTHESIZE only — no GATE (blocked) and no FOLLOW-UP.
    expect(mockModel).toHaveBeenCalledTimes(2);
  });

  it("fast-fails on a blocked step: no gate, no replan, honest synthesis", async () => {
    mockModel
      .mockResolvedValueOnce(msg(JSON.stringify({ steps: [{ tool: "capture_network", args: {} }] }))) // PLAN
      .mockResolvedValueOnce(msg("I could not capture the network traffic; deep capture is unavailable.")); // SYNTHESIZE (no GATE in between)
    mockExec.mockResolvedValueOnce([{
      tool: "capture_network",
      summary: "0 requests (page-shim limited)",
      status: "partial",
      warnings: [],
      args: {},
      meta: { blocked: true, blockedReason: "Deep network capture is unavailable in this build." }
    }]);

    const r = await runPipeline({ userMessage: "what api calls does this app make", settings });

    expect(r.ok).toBe(true);
    // PLAN + SYNTHESIZE only — the gate is skipped entirely on a blocked step.
    expect(mockModel).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledTimes(1);
    // The blocked reason is passed into the synthesis prompt so the answer is honest.
    const synthCall = mockModel.mock.calls[1]?.[0];
    expect(JSON.stringify(synthCall?.messages ?? [])).toContain("Deep network capture is unavailable in this build.");
  });
});
