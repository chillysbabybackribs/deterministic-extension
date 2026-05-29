/**
 * The pipeline loop — the universal request path.
 *
 *   PLAN (model)  →  EXECUTE (deterministic fat tools, persisted)  →
 *   MERGE + GATE (model): synthesize | grep | replan  →  loop until done.
 *
 * The model is invoked only to plan, gate/merge, and finally synthesize. It
 * never drives tools turn-by-turn and never sees raw tool output — only compact
 * summaries. A loop budget bounds iteration; if the gate never says
 * "synthesize", we synthesize the best accumulated answer and note what's
 * missing.
 */

import {
  callAnthropicMessage,
  extractText,
  streamAnthropicMessage,
  type AnthropicMessageParam
} from "../../model/anthropicToolClient";
import type { AppSettings } from "../../settings/settingsStore";
import { makeId } from "../../shared/id";
import type { RunProgressEvent, RunResponse } from "../../shared/protocol";
import type { EvidencePacket } from "../../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../../execution/executionTypes";
import { clearTask } from "../../tools/fat";
import type { RunControl } from "../runControl";
import { buildPlan, type CurrentPageContext, type Plan, type PlanStep, type PriorAttempt } from "./planner";
import { runGate } from "./gate";
import { runFollowup, runCapabilityExplainer } from "./followup";
import { renderHistory, priorTurns } from "./conversationHistory";
import {
  isEngineQuestion,
  searchEngineCorpus,
  renderEngineGrounding
} from "../../companion/engineKnowledgeCorpus";
import type { ChatContextMessage } from "../../conversation/conversationTypes";
import { describeActiveSource, type ActiveWorkingFileDescriptor } from "../../filecorpus/corpusTypes";
import { executePlan, type DeferredPlanSteps, type ExecutedStep, type ExecuteContext } from "./executePlan";
import { hideAllActionableOverlays, type OverlayCaptureResult } from "../../tools/elementOverlay";
import type { PrefetchedBeforeObservation } from "../../tools/fat";
import { resetResearchTab, setResearchTabId } from "../../tools/researchTab";
import { runInteractionFastPath } from "./interactionFastPath";
import { getCachedSiteRecon } from "../reconCache";
import { renderSiteRecon } from "../../tools/siteRecon";
import { buildPagePlanningContext } from "./pagePlanningContext";
import { shouldScanCurrentPage } from "./pageScanGate";
import { routePrompt } from "./router";
import { runResearchPath } from "./researchPath";
import { fetchResearchPage } from "./researchLoopFetcher";
import { classifyComplexity, selectModel, type ModelStep } from "../../model/modelPolicy";

const MAX_ITERATIONS = 5;
const MAX_DEFERRED_PLAN_RESUMES = 4;
/**
 * How many times the assistant may PROACTIVELY continue (the follow-up step
 * returning "proceed") within a single user turn before it must stop and answer.
 * Bounds autonomous chaining so a mis-judged or no-progress continuation cannot
 * loop; the no-progress backstop (priorAttempts/dropNoProgressSteps) also guards
 * each proactive round, and a proceed that yields nothing new ends the chain.
 */
const MAX_PROACTIVE_ROUNDS = 2;

const SYNTHESIS_SYSTEM_PROMPT = [
  "You are the final-answer writer for a Chrome assistant.",
  "The accumulated summary was produced by a deterministic pipeline that ALREADY opened tabs, navigated, searched the web, and read/extracted the pages on the user's behalf. Those actions succeeded — the content below is the result. So NEVER tell the user you cannot open, display, browse, or navigate to a page, and never tell them to go open it themselves: the system already did, and may still have the page open. Just answer from the content. (Only state a limitation when an explicit blocked-capability reason is provided below.)",
  "Answer the user using ONLY the accumulated summary provided (and the authoritative engine facts, when those are provided). Do not invent facts not present in them.",
  "When 'Authoritative facts about the optional background engine' are provided, the user is asking about the engine or why a task was limited: answer FROM those facts — they are correct; do not contradict them or substitute generic assumptions about how browser extensions work. Explain naturally and tailor the answer to what the user was doing.",
  "When earlier conversation turns are provided, treat this as a continuing conversation: resolve references to earlier turns, build on what was already said, and do not repeat information the user already has unless it is needed to answer.",
  "If the summary is incomplete, answer what is supported and clearly note what could not be determined.",
  "If a required capability was unavailable (a blocked-capability reason is provided), do not pretend the task succeeded or fabricate results: state plainly that it could not be completed, explain what is needed, and give only whatever partial information was genuinely gathered.",
  "LINKS: when you reference a web page, write a Markdown link with SHORT, descriptive text — e.g. [Playwright documentation](https://playwright.dev/). NEVER paste a bare URL (no `https://…` on its own, no `👉 https://…`). Do NOT decorate links with arrow/emoji bullets. Do NOT append a footer like 'sourced from the web (example.com)' — if you cite web sources, use a normal 'Sources' list of descriptive Markdown links only.",
  "Be direct and concise. Do NOT append follow-up questions or suggested next steps — that is handled separately."
].join("\n");

export async function runPipeline(args: {
  userMessage: string;
  settings: AppSettings;
  /** Prior conversation turns so the whole turn builds on the conversation. */
  history?: ChatContextMessage[];
  /** Structured UI capture text from the side panel, when the user selected/captured an element. */
  activeCaptureContext?: string;
  /** When set, a working file is attached — planner/gate query it via query_file. */
  activeWorkingFile?: ActiveWorkingFileDescriptor;
  onProgress?: (event: RunProgressEvent) => void;
  onAnswerDelta?: (delta: string) => void;
  control?: RunControl;
}): Promise<RunResponse> {
  const taskId = makeId("task");
  // New turn = new task: result pages open in a fresh tab, not the prior task's.
  resetResearchTab();
  const activity: ExecutionLogEntry[] = [];
  const model = args.settings.model.model;
  // MODEL AWARENESS: label the turn's complexity once, then pick a model PER STEP
  // (mechanical steps → fast tier; synthesis/chat → strong; a complex task bumps
  // mechanical steps up). Additive — every call still happens; we only choose
  // which model runs it. See model/modelPolicy.ts.
  const complexity = classifyComplexity(args.userMessage);
  const pick = (step: ModelStep): string => selectModel({ step, complexity, settings: args.settings.model }).model;
  const log = (entry: Omit<ExecutionLogEntry, "id" | "timestamp">) => {
    activity.push({ id: makeId("log"), timestamp: new Date().toISOString(), ...entry });
  };
  const emit = (event: Omit<RunProgressEvent, "id" | "timestamp">) => {
    args.onProgress?.({ id: makeId("progress"), timestamp: new Date().toISOString(), ...event });
  };

  let accumulator = "";
  let missing = "";
  const warnings: string[] = [];
  const priorAttempts: PriorAttempt[] = [];
  let blockedReason = "";
  // The intent currently being worked. Starts as the user's message; a proactive
  // follow-up ("proceed") replaces it with the next-step directive so the loop
  // re-runs for that step and folds the result into the same response.
  let currentIntent = args.userMessage;
  // Accumulated answer across proactive rounds (each round's synthesis appended).
  let fullAnswer = "";
  // First capability gap a step raised this turn (e.g. CSP-blocked response
  // bodies). Surfaced on the response to drive the opt-in companion pill.
  let capabilityGap: RunResponse["capabilityGap"];
  // When the user asks about the engine / why a task was limited, ground the
  // answer in the AUTHORED engine knowledge (retrieved with their ORIGINAL
  // prompt) so the assistant explains it accurately + tailored — instead of
  // improvising (which got the capture facts wrong). The original prompt is the
  // prior user turn; the engine question itself is the current message.
  let engineGrounding = "";
  if (isEngineQuestion(args.userMessage)) {
    const prior = priorTurns(args.history, args.userMessage);
    const originalPrompt = [...(prior ?? [])].reverse().find((t) => t.role === "user")?.content ?? args.userMessage;
    engineGrounding = renderEngineGrounding(searchEngineCorpus(originalPrompt));
  }
  // The actionable overlay is left painted by act_on_page so the user can see the
  // map; we tear it down ONCE here when the whole turn finishes (see finally).
  let overlayPainted = false;
  // Ranked actionable map from the interaction fast-path, used to SEED the first
  // plan so the model targets by overlayIndex instead of guessing blind.
  let actionableHint: string | undefined;
  let prefetchedActionableMap: OverlayCaptureResult | undefined;
  let prefetchedBeforeObservation: PrefetchedBeforeObservation | undefined;

  try {
    // FRONT-DOOR ROUTER: one cheap classify call decides chat vs tools. A `chat`
    // verdict answers directly from the model — no overlay, no planner, no
    // pipeline. Skipped when the turn already implies tools: an engine question
    // (grounded answer), an attached working file, or captured page context.
    // Default is tools, so a misroute never strands a real task.
    await args.control?.checkpoint();
    const impliesTools = isEngineQuestion(args.userMessage) || !!args.activeWorkingFile || !!args.activeCaptureContext;
    if (!impliesTools) {
      const route = await routePrompt({
        userMessage: args.userMessage,
        settings: args.settings,
        history: args.history,
        model: pick("router"),
        signal: args.control?.signal
      });
      log({ level: "info", label: "Route", details: `Decision: ${route} · complexity: ${complexity}`, toolName: "router", actionLabel: "Router", status: "completed" });
      if (route === "chat") {
        const answer = await answerChat({
          userMessage: args.userMessage,
          settings: args.settings,
          history: args.history,
          model: pick("chat"),
          signal: args.control?.signal,
          onAnswerDelta: args.onAnswerDelta
        });
        log({ level: "info", label: "Synthesis", details: "Chat answer ready (no tools).", toolName: "chat", actionLabel: "Chat", status: "completed" });
        return { ok: true, answer, activity, evidence: emptyEvidence(args.userMessage, warnings) };
      }
    }

    // INTERACTION FAST-PATH (pipeline inversion): for page-interaction prompts,
    // capture the overlay FIRST, rank the prompt over the element corpus, and
    // either fire a confident read-only action with NO model, or fall through to
    // the planner seeded with the ranked map.
    await args.control?.checkpoint();
    // Pull the active tab's pre-built site inventory (auto-captured on page load)
    // so escalations can tell the model what OTHER pages exist, not just this one.
    let currentPageContext = await readCurrentPageContext();
    let siteReconText = readCachedSiteReconText(currentPageContext?.tabId);
    // URL-FIRST GATE: the overlay scan (showActionableOverlay) is the slow part of
    // a turn. Decide cheaply — from the prompt + current URL/title + known corpus
    // sites, no DOM — whether it's worth running. A web-research prompt on an
    // unrelated page skips it entirely instead of mapping a useless page.
    const scanDecision = shouldScanCurrentPage({
      userMessage: args.userMessage,
      url: currentPageContext?.url,
      // A captured UI context is an explicit "act on this page" signal — always scan.
      hasActiveCaptureContext: !!args.activeCaptureContext
    });
    const pagePlanningContext = scanDecision.scan
      ? await buildPagePlanningContext({
          userMessage: args.userMessage,
          tabId: currentPageContext?.tabId
        })
      : undefined;
    if (pagePlanningContext) {
      overlayPainted = true;
      prefetchedActionableMap = pagePlanningContext.capture;
      log({
        level: "info",
        label: "Page map",
        details: pagePlanningContext.logSummary,
        toolName: "page_planning_context",
        actionLabel: "Overlay corpus",
        status: "completed"
      });
    } else {
      log({
        level: "info",
        label: "Page map",
        details: `Skipped the page scan — ${scanDecision.reason}.`,
        toolName: "page_planning_context",
        actionLabel: "Scan gate",
        status: "completed"
      });
    }
    // The interaction fast-path ALSO captures the overlay (the page DOM scan) when
    // no pre-planning capture exists. If the URL-first gate decided this page is
    // irrelevant, the fast-path must NOT independently re-run that scan — skip it.
    // It only ever fires for page-interaction intents anyway, which the gate would
    // have flagged as scan-worthy.
    const fastPath = scanDecision.scan
      ? await runInteractionFastPath({
          userMessage: args.userMessage,
          tabId: currentPageContext?.tabId,
          capture: pagePlanningContext?.capture,
          siteReconText: pagePlanningContext ? undefined : siteReconText,
          onProgress: (label, detail) => emit({ level: "info", label, detail, status: "running" })
        })
      : ({ kind: "skip" } as const);
    if (fastPath.kind === "fired") {
      overlayPainted = true;
      log({ level: "info", label: "Interaction", details: `Deterministic match (no model): ${fastPath.answer}`, toolName: "interaction_fast_path", actionLabel: "Fast-path", status: "completed" });
      // Stream the deterministic answer and finish — no planner, no model spend.
      args.onAnswerDelta?.(fastPath.answer);
      return { ok: true, answer: fastPath.answer, activity, evidence: emptyEvidence(args.userMessage, warnings) };
    }
    if (fastPath.kind === "escalate") {
      if (fastPath.capture) {
        overlayPainted = true;
        prefetchedActionableMap = fastPath.capture;
      }
      prefetchedBeforeObservation = fastPath.prefetchedBeforeObservation;
      actionableHint = pagePlanningContext ? undefined : fastPath.hint;
      log({ level: "info", label: "Interaction", details: `Escalating to planner: ${fastPath.reason}`, toolName: "interaction_fast_path", actionLabel: "Fast-path", status: "completed" });
    }

    // PROACTIVE OUTER LOOP: one pass per intent. The first pass answers the
    // user's message; a "proceed" follow-up sets currentIntent to the next-step
    // directive and runs another pass, appending its answer. Bounded by
    // MAX_PROACTIVE_ROUNDS; carries accumulator + priorAttempts across passes so
    // the no-progress backstop prevents a continuation from repeating work.
    for (let proactiveRound = 0; proactiveRound <= MAX_PROACTIVE_ROUNDS; proactiveRound += 1) {
    // Per-intent state resets each proactive pass; the cross-turn accumulator,
    // priorAttempts, and warnings persist so later passes build on earlier ones.
    missing = "";
    blockedReason = "";
    let roundAnswer = "";

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      await args.control?.checkpoint();

      // PLAN
      if (!(proactiveRound === 0 && iteration === 1)) {
        currentPageContext = await readCurrentPageContext();
      }
      siteReconText = readCachedSiteReconText(currentPageContext?.tabId);
      emit({ level: "info", label: "Plan", detail: iteration === 1 ? "Building a plan." : "Re-planning for missing information.", status: "running" });
      const planResult = await buildPlan({
        settings: args.settings,
        userMessage: currentIntent,
        history: args.history,
        accumulatedSummary: accumulator || undefined,
        missing: missing || undefined,
        priorAttempts,
        // Seed only the first plan of the FIRST pass with the ranked map; later
        // plans rely on prior attempts + accumulated summaries (fresh maps).
        actionableHint: proactiveRound === 0 && iteration === 1 ? actionableHint : undefined,
        pagePlanningContext: proactiveRound === 0 && iteration === 1 ? pagePlanningContext?.plannerText : undefined,
        siteReconText,
        currentPageContext,
        activeCaptureContext: args.activeCaptureContext,
        activeWorkingFile: args.activeWorkingFile,
        model: pick("planner"),
        signal: args.control?.signal
      });
      warnings.push(...planResult.warnings);
      log({
        level: "info",
        label: "Plan",
        details: `${planResult.plan.steps.length} step(s): ${planResult.plan.steps.map((s) => s.tool).join(", ") || "none"}. ${planResult.plan.reason}`,
        toolName: model,
        actionLabel: "Plan",
        status: planResult.plan.steps.length ? "completed" : "failed"
      });

      if (!planResult.plan.steps.length) {
        // Nothing to run — answer directly from what we have (or the model's knowledge).
        break;
      }

      // WEB-RESEARCH PATH: when the model's first plan is search-dominated and no
      // page/file task is attached, divert to the deterministic research loop
      // instead of the generic execute/gate loop. The model "built the search
      // loop" (the search_web steps); the loop now opens results one at a time in
      // the working tab, extracts/cleans/sections/dedupes into the corpus, and a
      // deterministic corpus search returns the structured summary the synthesis
      // step writes from. No mid-loop model gate — one pass, then synthesize.
      const searchQueries = extractSearchQueries(planResult.plan);
      const isResearchTurn =
        proactiveRound === 0 &&
        iteration === 1 &&
        searchQueries.length > 0 &&
        planResult.plan.steps[0]?.tool === "search_web" &&
        !args.activeWorkingFile &&
        !args.activeCaptureContext &&
        !planResult.plan.steps.some((s) => s.tool === "act_on_page");
      if (isResearchTurn) {
        await args.control?.checkpoint();
        emit({ level: "info", label: "Research", detail: "Running the deterministic research loop.", status: "running" });
        // Run the WHOLE pipeline in the user's current tab: adopt it as the task's
        // research tab up front so the SERP and every result page navigate this one
        // tab instead of spawning new ones.
        const workingTabId = currentPageContext?.tabId;
        if (workingTabId !== undefined) {
          setResearchTabId(workingTabId);
        }
        const research = await runResearchPath({
          query: currentIntent,
          searchQueries,
          currentUrl: currentPageContext?.url,
          workingTabId,
          now: new Date().toISOString(),
          fetchPage: fetchResearchPage,
          onProgress: (message) => emit({ level: "info", label: "Research", detail: message, status: "running" }),
          shouldStop: () => args.control?.signal?.aborted ?? false
        });
        warnings.push(...research.warnings);
        log({
          level: research.structuredSummary ? "info" : "warning",
          label: "Research",
          details: `Read ${research.visitedUrls.length} page(s); recalled ${research.recalledCount} section(s) from the corpus.`,
          toolName: "research_loop",
          actionLabel: "Research loop",
          status: research.structuredSummary ? "completed" : "partial"
        });
        if (research.structuredSummary) {
          // One pass, then synthesize. A thin result is a pipeline bug to fix, not
          // a second model-gated pass.
          accumulator = [accumulator, research.structuredSummary].filter(Boolean).join("\n\n");
          missing = "";
          break;
        }
        // The loop yielded nothing usable (no results, all dead/thin). Rather than
        // dead-end at synthesis, fall through to the generic execute/gate loop as a
        // graceful degrade — this is recovery, not a second research pass.
        warnings.push(research.missing || "The research loop gathered no usable content.");
      }

      // EXECUTE (deterministic) + persist
      await args.control?.checkpoint();
      emit({ level: "info", label: "Execute", detail: `Running ${planResult.plan.steps.length} deterministic step(s).`, status: "running" });
      const execution = await executePlanWithAutoResume({
        taskId,
        initialPlan: planResult.plan,
        userMessage: currentIntent,
        initialContext: {
          userMessage: currentIntent,
          prefetchedActionableMap: proactiveRound === 0 && iteration === 1 ? prefetchedActionableMap : undefined,
          prefetchedBeforeObservation: proactiveRound === 0 && iteration === 1 ? prefetchedBeforeObservation : undefined,
          annotateDeferrals: false
        },
        checkpoint: () => args.control?.checkpoint(),
        emit,
        log
      });
      const executed = execution.executed;
      prefetchedActionableMap = undefined;
      prefetchedBeforeObservation = undefined;
      // Any visible page-opening or page-acting step may have painted the overlay.
      // Mark it so the finally tears every tracked overlay down once at turn end.
      if (planResult.plan.steps.some((s) => s.tool === "act_on_page" || s.tool === "understand_page")) {
        overlayPainted = true;
      }

      if (!execution.unresolvedDeferred && shouldAutoUnderstandPostAction(currentIntent, executed)) {
        await args.control?.checkpoint();
        emit({ level: "info", label: "Execute", detail: "Reading the post-action page state.", status: "running" });
        const postActionUnderstanding = await executePlan(
          taskId,
          { reason: "deterministic post-action page report", steps: [{ tool: "understand_page", args: {} }] },
          { userMessage: currentIntent, annotateDeferrals: false }
        );
        executed.push(...postActionUnderstanding);
      }

      // Capture the first capability gap any step raised (e.g. CSP-blocked
      // response bodies) so the response can offer the opt-in companion. Kept
      // even if the turn otherwise succeeds — it's an upgrade hint, not a failure.
      if (!capabilityGap) {
        const gapStep = executed.find((e) => e.meta?.capabilityGap);
        if (gapStep?.meta?.capabilityGap) {
          capabilityGap = gapStep.meta.capabilityGap;
        }
      }
      logExecution(log, executed);
      const roundSummary = executed.map((e) => `[${e.tool}] ${e.summary}`).join("\n\n");

      // Record every executed step so the next re-plan must vary (and so the
      // deterministic no-progress backstop can drop identical repeats).
      for (const step of executed) {
        priorAttempts.push({ tool: step.tool, args: step.args, summary: step.summary });
      }

      // FAST-FAIL on a blocked capability. A blocked step (e.g. network capture
      // when deep capture is off) can never be made sufficient by re-running or
      // re-planning, so we stop the loop and answer honestly with what's needed,
      // rather than burning iterations on doomed re-plans.
      const blocked = executed.find((e) => e.meta?.blocked);
      if (blocked) {
        blockedReason = blocked.meta?.blockedReason ?? "A required capability is unavailable in this build.";
        accumulator = [accumulator, roundSummary].filter(Boolean).join("\n\n");
        missing = blockedReason;
        log({
          level: "warning",
          label: "Blocked",
          details: blockedReason,
          toolName: blocked.tool,
          actionLabel: "Capability unavailable",
          status: "failed"
        });
        break;
      }

      if (execution.unresolvedDeferred) {
        accumulator = [accumulator, roundSummary].filter(Boolean).join("\n\n");
        missing = execution.unresolvedDeferred.reason;
        log({
          level: "info",
          label: "Evaluate",
          details: `Planner help needed for deferred step(s): ${execution.unresolvedDeferred.steps.map((s) => s.tool).join(", ")}`,
          toolName: model,
          actionLabel: "Deterministic checkpoint",
          status: "completed"
        });
        continue;
      }

      // MERGE + GATE (model)
      await args.control?.checkpoint();
      emit({ level: "info", label: "Evaluate", detail: "Checking whether the gathered information is sufficient.", status: "running" });
      const gate = await runGate({
        settings: args.settings,
        userMessage: currentIntent,
        history: args.history,
        priorAccumulator: accumulator,
        newSummary: roundSummary,
        activeWorkingFile: args.activeWorkingFile,
        model: pick("gate"),
        signal: args.control?.signal
      });
      accumulator = gate.accumulator;
      missing = gate.missing;
      log({
        level: "info",
        label: "Evaluate",
        details: `Decision: ${gate.decision}${gate.missing ? ` — missing: ${gate.missing}` : ""}`,
        toolName: model,
        actionLabel: "Sufficiency gate",
        status: "completed"
      });

      if (gate.decision === "synthesize") {
        break;
      }
      if (gate.decision === "grep" && gate.grepQuery) {
        // Tier-1 recovery: grep runs as a one-step plan next iteration's execute,
        // but do it inline here to avoid an extra plan call.
        const grepRound = await executePlan(taskId, { steps: [{ tool: "grep_extractions", args: { query: gate.grepQuery } }], reason: "grep recovery" }, { userMessage: currentIntent });
        logExecution(log, grepRound);
        const grepSummary = grepRound.map((e) => `[grep] ${e.summary}`).join("\n\n");
        const grepGate = await runGate({
          settings: args.settings,
          userMessage: currentIntent,
          history: args.history,
          priorAccumulator: accumulator,
          newSummary: grepSummary,
          activeWorkingFile: args.activeWorkingFile,
          model: pick("gate"),
          signal: args.control?.signal
        });
        accumulator = grepGate.accumulator;
        missing = grepGate.missing;
        if (grepGate.decision === "synthesize") {
          break;
        }
        // else fall through to next iteration (replan)
      }
      // decision === "replan" (or grep that still wasn't enough): loop continues
    }

    // SYNTHESIZE this pass. After a proactive continuation, separate the new
    // answer from the prior one with a blank line in the stream.
    await args.control?.checkpoint();
    emit({ level: "info", label: "Answer", detail: proactiveRound === 0 ? "Writing the final answer." : "Continuing with the next step.", status: "running" });
    const separator = fullAnswer ? "\n\n" : "";
    if (separator) {
      args.onAnswerDelta?.(separator);
    }
    roundAnswer = await synthesize({
      settings: args.settings,
      userMessage: currentIntent,
      history: args.history,
      accumulator,
      missing,
      blockedReason,
      engineGrounding,
      activeWorkingFile: args.activeWorkingFile,
      model: pick("synthesis"),
      onAnswerDelta: args.onAnswerDelta,
      signal: args.control?.signal
    });
    log({ level: "info", label: "Answer", details: roundAnswer ? "Final answer ready." : "Empty answer.", toolName: model, actionLabel: "Synthesis", status: roundAnswer ? "completed" : "failed" });
    fullAnswer += separator + roundAnswer;

    // FOLLOW-UP (separate, post-answer): the answer above stands alone. This
    // lightweight step decides what comes next — nothing, a PROACTIVE next step
    // run inline (proceed), an offer (suggestion), or a goal question (probe).
    // Default is nothing. Skipped on a blocked answer (never chain off a
    // capability failure) or an empty one. Best-effort: a follow-up failure
    // never affects the answer already streamed.
    let proceeded = false;
    if (roundAnswer && !blockedReason) {
      try {
        await args.control?.checkpoint();
        const followup = await runFollowup({
          settings: args.settings,
          userMessage: currentIntent,
          history: args.history,
          answer: roundAnswer,
          accumulator,
          model: pick("followup"),
          signal: args.control?.signal
        });
        if (followup.kind === "proceed" && followup.text && proactiveRound < MAX_PROACTIVE_ROUNDS) {
          // Run the next step inline: make it the current intent and loop. The
          // accumulator + priorAttempts carry over, so the no-progress backstop
          // stops a continuation that would just repeat earlier work.
          log({ level: "info", label: "Continue", details: `Proactively running: ${followup.text}`, toolName: model, actionLabel: "Proactive", status: "completed" });
          currentIntent = followup.text;
          proceeded = true;
        } else if ((followup.kind === "suggestion" || followup.kind === "probe") && followup.text) {
          const followupText = `\n\n${followup.text}`;
          args.onAnswerDelta?.(followupText);
          fullAnswer += followupText;
          log({ level: "info", label: "Follow-up", details: `${followup.kind}: ${followup.text}`, toolName: model, actionLabel: "Follow-up", status: "completed" });
        }
        // followup.kind === "none" (or a proceed past the cap): add nothing.
      } catch {
        // Follow-up is additive; never let it break the turn.
      }
    }

    if (proceeded) {
      continue; // outer proactive loop: work the new intent and append its answer
    }
    break; // done — no proactive continuation
    }

    // CAPABILITY-GAP EXPLAINER: when the turn hit a gap an opt-in engine could
    // clear, generate a prompt-specific explanation (why THIS task was limited +
    // what the engine unlocks for it) for the pill's details. Best-effort — a
    // failure just leaves the pill on its generic copy.
    if (capabilityGap && fullAnswer) {
      try {
        await args.control?.checkpoint();
        const detail = await runCapabilityExplainer({
          settings: args.settings,
          userMessage: args.userMessage,
          answer: fullAnswer,
          capability: capabilityGap.capability,
          reason: capabilityGap.reason,
          model: pick("followup"),
          signal: args.control?.signal
        });
        if (detail) {
          capabilityGap = { ...capabilityGap, detail };
        }
      } catch {
        // leave the generic pill copy
      }
    }

    await clearTask(taskId).catch(() => undefined);
    return {
      ok: Boolean(fullAnswer),
      answer: fullAnswer || "I could not produce an answer.",
      activity,
      evidence: emptyEvidence(args.userMessage, warnings),
      capabilityGap,
      error: fullAnswer ? undefined : "Empty final answer."
    };
  } catch (error) {
    await clearTask(taskId).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Pipeline failed.";
    log({ level: "error", label: "Run failed", details: message, toolName: model, actionLabel: "Pipeline", status: "failed", warning: message });
    return { ok: false, answer: message, activity, evidence: emptyEvidence(args.userMessage, warnings), error: message };
  } finally {
    // Tear the actionable overlay down once the whole turn is complete (after the
    // answer has been synthesized/streamed), so it stays visible for the full
    // response rather than the sub-second action window. No-op when no overlay
    // was painted or no page tab exists.
    if (overlayPainted) {
      await hideAllActionableOverlays().catch(() => undefined);
    }
  }
}

async function executePlanWithAutoResume(args: {
  taskId: string;
  initialPlan: Plan;
  userMessage: string;
  initialContext: ExecuteContext;
  checkpoint: () => Promise<void> | undefined;
  emit: (event: Omit<RunProgressEvent, "id" | "timestamp">) => void;
  log: (entry: Omit<ExecutionLogEntry, "id" | "timestamp">) => void;
}): Promise<{ executed: ExecutedStep[]; unresolvedDeferred?: DeferredPlanSteps }> {
  const executed: ExecutedStep[] = [];
  let plan: Plan | undefined = args.initialPlan;
  let context: ExecuteContext = args.initialContext;

  for (let resumeCount = 0; plan && resumeCount <= MAX_DEFERRED_PLAN_RESUMES; resumeCount += 1) {
    if (resumeCount > 0) {
      await args.checkpoint();
      args.emit({
        level: "info",
        label: "Execute",
        detail: `Continuing ${plan.steps.length} deterministic deferred step(s).`,
        status: "running"
      });
    }

    const batch = await executePlan(args.taskId, plan, context);
    executed.push(...batch);

    const deferred = batch.at(-1)?.deferred;
    if (!deferred) {
      return { executed };
    }

    if (resumeCount >= MAX_DEFERRED_PLAN_RESUMES || !canAutoResumeDeferredPlan(deferred)) {
      annotateDeferredStepForModel(batch.at(-1), deferred);
      return { executed, unresolvedDeferred: deferred };
    }

    args.log({
      level: "info",
      label: "Execute",
      details: `Auto-resuming deferred deterministic step(s): ${deferred.steps.map((s) => s.tool).join(", ")}`,
      toolName: "pipeline",
      actionLabel: "Deterministic continuation",
      status: "completed"
    });
    plan = { reason: "auto-resume deferred page-state steps", steps: deferred.steps };
    context = { userMessage: args.userMessage, annotateDeferrals: false };
  }

  return { executed };
}

function canAutoResumeDeferredPlan(deferred: DeferredPlanSteps): boolean {
  const first = deferred.steps[0];
  if (!first) {
    return false;
  }

  if (deferred.boundary === "post_action") {
    return isNonMutatingDeterministicStep(first);
  }

  if (deferred.boundary === "post_open_or_map" || deferred.boundary === "post_reload") {
    return first.tool === "act_on_page" && hasStableActionTargets(first);
  }

  return false;
}

function isNonMutatingDeterministicStep(step: PlanStep): boolean {
  return step.tool === "understand_page" ||
    step.tool === "capture_network" ||
    step.tool === "inspect_runtime" ||
    step.tool === "grep_extractions" ||
    step.tool === "read_workspace" ||
    step.tool === "query_file";
}

function hasStableActionTargets(step: PlanStep): boolean {
  const actions = Array.isArray(step.args.steps) ? step.args.steps : [];
  if (!actions.length) {
    return false;
  }
  return actions.every((action) => {
    if (!isRecord(action)) {
      return false;
    }
    const actionName = typeof action.action === "string" ? action.action : "";
    const target = isRecord(action.target) ? action.target : undefined;
    if (actionName === "press_key" || actionName === "scroll") {
      return true;
    }
    if (!target) {
      return false;
    }
    if (typeof target.overlayIndex === "number" || typeof target.elementRef === "string") {
      return false;
    }
    return ["selector", "text", "role", "name", "label", "placeholder"].some((key) => {
      const value = target[key];
      return typeof value === "string" && value.trim();
    });
  });
}

function annotateDeferredStepForModel(step: ExecutedStep | undefined, deferred: DeferredPlanSteps): void {
  if (!step || step.summary.includes(deferred.reason)) {
    return;
  }
  step.summary = `${step.summary}\n\n${deferred.reason}`;
  step.warnings = [...step.warnings, deferred.reason];
}

function shouldAutoUnderstandPostAction(userMessage: string, executed: ExecutedStep[]): boolean {
  if (!asksForPostActionPageReport(userMessage)) {
    return false;
  }
  const lastActionIndex = findLastIndex(executed, (step) => step.tool === "act_on_page" && step.status !== "failed");
  if (lastActionIndex < 0) {
    return false;
  }
  return !executed.slice(lastActionIndex + 1).some((step) => step.tool === "understand_page");
}

function asksForPostActionPageReport(userMessage: string): boolean {
  const text = userMessage.toLowerCase().replace(/\s+/g, " ");
  const asksAfterAction = /\b(?:then|and)\b.+\b(?:tell|show|describe|report|summari[sz]e|explain)\b/.test(text);
  const asksForChange = /\b(?:what changed|what has changed|what happens?|what happened|result|changed|new page|current page|where (?:we|it) (?:are|landed)|now visible)\b/.test(text);
  const action = /\b(?:click|tap|open|go to|navigate|follow|visit|select|choose|press|submit)\b/.test(text);
  return action && asksAfterAction && asksForChange;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

async function readCurrentPageContext(): Promise<CurrentPageContext | undefined> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      return undefined;
    }
    return {
      tabId: activeTab.id,
      title: activeTab.title,
      url: activeTab.url,
      status: activeTab.status
    };
  } catch {
    return undefined;
  }
}

function readCachedSiteReconText(tabId: number | undefined): string | undefined {
  try {
    const recon = tabId !== undefined ? getCachedSiteRecon(tabId) : undefined;
    return recon && recon.paths.length ? renderSiteRecon(recon, 40) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the search queries from a plan's search_web steps, in order. */
function extractSearchQueries(plan: Plan): string[] {
  return plan.steps
    .filter((step) => step.tool === "search_web")
    .map((step) => (typeof step.args.query === "string" ? step.args.query.trim() : ""))
    .filter(Boolean);
}

async function synthesize(args: {
  settings: AppSettings;
  userMessage: string;
  history?: ChatContextMessage[];
  accumulator: string;
  missing: string;
  blockedReason?: string;
  /** Authored engine-knowledge grounding, when the user asked about the engine. */
  engineGrounding?: string;
  /** When set, instruct the answer to cite the working file's locations. */
  activeWorkingFile?: ActiveWorkingFileDescriptor;
  model?: string;
  onAnswerDelta?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const historyText = renderHistory(args.history);
  const workingFile = args.activeWorkingFile;
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
      args.engineGrounding ? `${args.engineGrounding}\n` : "",
      `User prompt:\n${args.userMessage}`,
      "",
      args.accumulator ? `Accumulated findings:\n${args.accumulator}` : "No information could be gathered.",
      args.missing ? `\nKnown gaps: ${args.missing}` : "",
      workingFile
        ? `\nThe user has attached ${describeActiveSource(workingFile)} as the working source. The findings above include passages from it, each tagged with a [location] like [src/auth/login.ts › §3 Setup · line 12], [§9 SQL Injection Testing · line 58], [page 3], or [Sheet 'Q3' · row 14]. When a fact comes from the source, cite its location inline right after the claim using that exact text (e.g. "the login handler (src/auth/login.ts › line 12)"). End the answer with a "Sources" section listing each distinct location you cited, one per line. If part of the answer came from a web search instead of the source, label it as from the web. Do NOT attribute content to a file or section it did not actually come from.`
        : "",
      args.blockedReason ? `\nIMPORTANT — a required capability was unavailable, so the request could not be fully completed. Clearly tell the user this and explain what is needed, using this reason verbatim in plain language:\n${args.blockedReason}` : "",
      "",
      "Write the final answer now."
    ].filter(Boolean).join("\n")
  }];

  if (args.onAnswerDelta) {
    const r = await streamAnthropicMessage({
      settings: args.settings, model: args.model, system: SYNTHESIS_SYSTEM_PROMPT, messages, signal: args.signal, onTextDelta: args.onAnswerDelta
    });
    return extractText(r.content);
  }
  const r = await callAnthropicMessage({ settings: args.settings, model: args.model, system: SYNTHESIS_SYSTEM_PROMPT, messages, signal: args.signal });
  return extractText(r.content);
}

const CHAT_SYSTEM_PROMPT = [
  "You are a helpful, direct assistant inside a browser extension.",
  "This prompt was routed as plain chat: answer it directly from your own knowledge or by transforming text the user provided.",
  "Do NOT claim to have browsed, searched, opened pages, or read files — no tools were used.",
  "Be concise and useful. Use the prior conversation for context when relevant."
].join("\n");

/** Direct model answer for prompts the router classified as `chat` (no tools). */
async function answerChat(args: {
  userMessage: string;
  settings: AppSettings;
  history?: ChatContextMessage[];
  model?: string;
  signal?: AbortSignal;
  onAnswerDelta?: (delta: string) => void;
}): Promise<string> {
  const historyText = renderHistory(args.history);
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
      `User prompt:\n${args.userMessage}`,
      "",
      "Answer now."
    ].filter(Boolean).join("\n")
  }];
  if (args.onAnswerDelta) {
    const r = await streamAnthropicMessage({
      settings: args.settings, model: args.model, system: CHAT_SYSTEM_PROMPT, messages, signal: args.signal, onTextDelta: args.onAnswerDelta
    });
    return extractText(r.content);
  }
  const r = await callAnthropicMessage({ settings: args.settings, model: args.model, system: CHAT_SYSTEM_PROMPT, messages, signal: args.signal });
  return extractText(r.content);
}

function logExecution(log: (e: Omit<ExecutionLogEntry, "id" | "timestamp">) => void, executed: ExecutedStep[]): void {
  for (const step of executed) {
    log({
      level: step.status === "failed" ? "error" : step.status === "partial" ? "warning" : "info",
      label: step.tool,
      details: step.summary.slice(0, 220),
      toolName: step.tool,
      actionLabel: "Execute",
      status: step.status === "failed" ? "failed" : step.status === "partial" ? "partial" : "completed",
      eventType: "tool"
    });
  }
}

function emptyEvidence(userGoal: string, warnings: string[]): EvidencePacket {
  return {
    id: makeId("evidence_packet"),
    createdAt: new Date().toISOString(),
    userGoal,
    quality: "thin",
    summary: "",
    items: [],
    stepResults: [],
    warnings,
    failures: [],
    missingInfo: [],
    searchCandidates: [],
    openedSources: [],
    extractedSections: [],
    extractedTextSample: "",
    extractionQuality: "thin",
    prunedTabIds: [],
    groupedTabIds: [],
    visibleBrowserActions: []
  };
}
