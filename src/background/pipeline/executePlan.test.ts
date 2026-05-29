import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FatToolName, FatToolResult } from "../../tools/fat";

vi.mock("../../tools/fat", () => ({
  runUnderstandPage: vi.fn(),
  runCaptureNetworkFat: vi.fn(),
  runInspectRuntime: vi.fn(),
  runSearchWeb: vi.fn(),
  runReadWorkspace: vi.fn(),
  runQueryFile: vi.fn(),
  runActOnPage: vi.fn(),
  runWriteWorkspace: vi.fn(),
  saveExtraction: vi.fn(async () => undefined),
  grepExtractions: vi.fn()
}));

vi.mock("../../tools/pageCorpusPass", () => ({
  runPageCorpusPass: vi.fn()
}));

import {
  grepExtractions,
  runActOnPage,
  runCaptureNetworkFat,
  runInspectRuntime,
  runUnderstandPage
} from "../../tools/fat";
import { runPageCorpusPass } from "../../tools/pageCorpusPass";
import { executePlan } from "./executePlan";

function fatResult(tool: FatToolName, summary: string): FatToolResult {
  return {
    tool,
    status: "success",
    summary,
    fullExtraction: {},
    warnings: []
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runPageCorpusPass).mockResolvedValue({
    kind: "captured",
    capture: { title: "Docs", url: "https://example.com/docs", elements: [] },
    shortlist: [],
    summary: "Mapped 3 actionable element(s) on Docs."
  } as never);
});

describe("executePlan page-state barriers", () => {
  it("defers page actions after understand_page so the next plan uses the fresh map", async () => {
    vi.mocked(runUnderstandPage).mockResolvedValue(fatResult("understand_page", "Read the docs page."));

    const executed = await executePlan("task", {
      reason: "map then click",
      steps: [
        { tool: "understand_page", args: {} },
        { tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 4 } }] } }
      ]
    });

    expect(executed).toHaveLength(1);
    expect(executed[0].summary).toContain("Mapped 3 actionable element");
    expect(executed[0].summary).toContain("Deferred 1 planned page-action step");
    expect(executed[0].warnings.join(" ")).toContain("fresh actionable map");
    expect(runActOnPage).not.toHaveBeenCalled();
  });

  it("still runs safe extraction steps before deferring a later page action", async () => {
    vi.mocked(runUnderstandPage).mockResolvedValue(fatResult("understand_page", "Read the docs page."));
    vi.mocked(grepExtractions).mockResolvedValue([
      { tool: "understand_page", path: "$.page.text", value: "pricing link" }
    ] as never);

    const executed = await executePlan("task", {
      reason: "map, grep, then click",
      steps: [
        { tool: "understand_page", args: {} },
        { tool: "grep_extractions", args: { query: "pricing" } },
        { tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 4 } }] } }
      ]
    });

    expect(executed).toHaveLength(2);
    expect(executed[1].tool).toBe("grep_extractions");
    expect(executed[1].summary).toContain("pricing link");
    expect(executed[1].summary).toContain("Deferred 1 planned page-action step");
    expect(runActOnPage).not.toHaveBeenCalled();
  });

  it("allows non-action page analysis after understand_page", async () => {
    vi.mocked(runUnderstandPage).mockResolvedValue(fatResult("understand_page", "Read the docs page."));
    vi.mocked(runCaptureNetworkFat).mockResolvedValue(fatResult("capture_network", "Captured endpoints."));

    const executed = await executePlan("task", {
      reason: "read and capture",
      steps: [
        { tool: "understand_page", args: {} },
        { tool: "capture_network", args: {} }
      ]
    });

    expect(executed.map((step) => step.tool)).toEqual(["understand_page", "capture_network"]);
    expect(runCaptureNetworkFat).toHaveBeenCalledTimes(1);
  });

  it("defers later page-dependent steps after act_on_page mutates the page", async () => {
    vi.mocked(runActOnPage).mockResolvedValue(fatResult("act_on_page", "Clicked the docs link."));

    const executed = await executePlan("task", {
      reason: "click then inspect",
      steps: [
        { tool: "act_on_page", args: { steps: [{ action: "click", target: { overlayIndex: 2 } }] } },
        { tool: "inspect_runtime", args: {} }
      ]
    });

    expect(executed).toHaveLength(1);
    expect(executed[0].summary).toContain("Clicked the docs link.");
    expect(executed[0].summary).toContain("Deferred 1 planned page-dependent step");
    expect(runInspectRuntime).not.toHaveBeenCalled();
  });
});
