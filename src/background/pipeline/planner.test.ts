import { describe, expect, it } from "vitest";
import { parsePlan, dropNoProgressSteps, attemptKey, renderCurrentPageContext, type PlanStep, type PriorAttempt } from "./planner";

describe("dropNoProgressSteps", () => {
  const cap = (args: Record<string, unknown> = {}): PlanStep => ({ tool: "capture_network", args });

  it("drops a step identical to a prior attempt", () => {
    const prior: PriorAttempt[] = [{ tool: "capture_network", args: {}, summary: "0 requests" }];
    const result = dropNoProgressSteps([cap()], prior);
    expect(result.steps).toHaveLength(0);
    expect(result.warnings[0]).toContain("repeats an earlier identical attempt");
  });

  it("keeps a step whose args differ from prior attempts", () => {
    const prior: PriorAttempt[] = [{ tool: "capture_network", args: { tabId: 1 }, summary: "x" }];
    expect(dropNoProgressSteps([cap({ tabId: 2 })], prior).steps).toHaveLength(1);
  });

  it("keeps a step with a different tool", () => {
    const prior: PriorAttempt[] = [{ tool: "capture_network", args: {}, summary: "x" }];
    expect(dropNoProgressSteps([{ tool: "understand_page", args: {} }], prior).steps).toHaveLength(1);
  });

  it("is a no-op when there are no prior attempts", () => {
    const steps: PlanStep[] = [cap(), { tool: "understand_page", args: {} }];
    const out = dropNoProgressSteps(steps, []);
    expect(out.steps).toBe(steps);
    expect(out.warnings).toHaveLength(0);
  });

  it("attemptKey is order-insensitive for arg keys", () => {
    expect(attemptKey("t", { a: 1, b: 2 })).toBe(attemptKey("t", { b: 2, a: 1 }));
  });
});

describe("parsePlan", () => {
  it("parses a valid plan", () => {
    const r = parsePlan(JSON.stringify({
      reason: "understand then capture",
      steps: [
        { tool: "understand_page", args: {}, rationale: "see the page" },
        { tool: "capture_network", args: { tabId: 3 } }
      ]
    }));
    expect(r.warnings).toEqual([]);
    expect(r.plan.reason).toBe("understand then capture");
    expect(r.plan.steps).toHaveLength(2);
    expect(r.plan.steps[0].tool).toBe("understand_page");
  });

  it("extracts JSON even with surrounding prose", () => {
    const r = parsePlan('Here is the plan:\n{"reason":"r","steps":[{"tool":"search_web","args":{"query":"rust"}}]}\nThanks!');
    expect(r.plan.steps).toHaveLength(1);
    expect(r.plan.steps[0].tool).toBe("search_web");
  });

  it("drops steps with unknown tools", () => {
    const r = parsePlan(JSON.stringify({ steps: [
      { tool: "browser_open_tab", args: {} },
      { tool: "understand_page", args: {} }
    ] }));
    expect(r.plan.steps).toHaveLength(1);
    expect(r.plan.steps[0].tool).toBe("understand_page");
    expect(r.warnings.join(" ")).toContain('unknown tool "browser_open_tab"');
  });

  it("drops steps missing required args", () => {
    const r = parsePlan(JSON.stringify({ steps: [
      { tool: "search_web", args: {} },              // missing query
      { tool: "write_workspace", args: { path: "a.txt" } }, // missing content
      { tool: "write_workspace", args: { path: "a.txt", content: "hi" } }
    ] }));
    expect(r.plan.steps).toHaveLength(1);
    expect(r.warnings.join(" ")).toContain('missing required arg "query"');
    expect(r.warnings.join(" ")).toContain('missing required arg "content"');
  });

  it("accepts query_file with a query and drops it without one", () => {
    const ok = parsePlan(JSON.stringify({ steps: [{ tool: "query_file", args: { query: "revenue" } }] }));
    expect(ok.plan.steps).toHaveLength(1);
    expect(ok.plan.steps[0].tool).toBe("query_file");

    const missing = parsePlan(JSON.stringify({ steps: [{ tool: "query_file", args: {} }] }));
    expect(missing.plan.steps).toHaveLength(0);
    expect(missing.warnings.join(" ")).toContain('missing required arg "query"');
  });

  it("accepts grep_extractions with a query", () => {
    const r = parsePlan(JSON.stringify({ steps: [{ tool: "grep_extractions", args: { query: "/auth" } }] }));
    expect(r.plan.steps).toHaveLength(1);
    expect(r.plan.steps[0].tool).toBe("grep_extractions");
  });

  it("rejects grep_extractions without a query", () => {
    const r = parsePlan(JSON.stringify({ steps: [{ tool: "grep_extractions", args: {} }] }));
    expect(r.plan.steps).toHaveLength(0);
  });

  it("validates act_on_page requires a non-empty steps array", () => {
    const empty = parsePlan(JSON.stringify({ steps: [{ tool: "act_on_page", args: { steps: [] } }] }));
    expect(empty.plan.steps).toHaveLength(0);
    const ok = parsePlan(JSON.stringify({ steps: [{ tool: "act_on_page", args: { steps: [{ action: "click" }] } }] }));
    expect(ok.plan.steps).toHaveLength(1);
  });

  it("handles non-JSON gracefully", () => {
    const r = parsePlan("I cannot help with that.");
    expect(r.plan.steps).toEqual([]);
    expect(r.warnings[0]).toContain("did not return valid JSON");
  });
});

describe("renderCurrentPageContext", () => {
  it("renders current tab state for the planner prompt", () => {
    const text = renderCurrentPageContext({
      tabId: 7,
      title: "Docs",
      url: "https://example.com/docs",
      status: "complete"
    });

    expect(text).toContain("tabId: 7");
    expect(text).toContain("title: Docs");
    expect(text).toContain("url: https://example.com/docs");
    expect(text).toContain("status: complete");
  });
});
