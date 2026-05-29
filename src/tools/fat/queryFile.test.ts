import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserToolExecution } from "../browserToolExecutor";

vi.mock("../browserToolExecutor", () => ({
  executeBrowserTool: vi.fn()
}));

import { executeBrowserTool } from "../browserToolExecutor";
import { runQueryFile } from "./queryFile";

function exec(output: Record<string, unknown>): BrowserToolExecution {
  return {
    callId: "c", toolName: "corpus_query", status: "success", output, warnings: [], summary: "ok",
    activity: {} as never, stepResult: {} as never, toolResult: {} as never,
    evidenceItems: [], failures: [], searchCandidates: [], openedSources: [],
    extractedSections: [], extractedTextSample: "", prunedTabIds: [], groupedTabIds: [],
    visibleActions: []
  };
}

const mockExec = vi.mocked(executeBrowserTool);
afterEach(() => vi.clearAllMocks());

describe("query_file fat tool", () => {
  it("returns a partial result that asks for a file when none is attached", async () => {
    mockExec.mockResolvedValue(exec({ active: false }));
    const result = await runQueryFile({ query: "revenue", userMessage: "what was Q3 revenue?" });
    expect(result.status).toBe("partial");
    expect(result.summary).toMatch(/No source is attached/i);
    expect(result.fullExtraction.active).toBe(false);
  });

  it("anchors retrieval to the prompt by unioning userMessage into the query", async () => {
    mockExec.mockResolvedValue(exec({ active: true, fileName: "data.csv", matchCount: 2, rendered: "[row 1] ..." }));
    await runQueryFile({ query: "revenue", userMessage: "what was Q3 revenue?" });
    const passed = mockExec.mock.calls[0][0];
    expect(passed.name).toBe("corpus_query");
    expect((passed.input as { query: string }).query).toContain("revenue");
    expect((passed.input as { query: string }).query).toContain("Q3");
  });

  it("summarizes matches with the file name and count on success", async () => {
    mockExec.mockResolvedValue(
      exec({ active: true, fileName: "report.pdf", matchCount: 3, rendered: "[page 2] the relevant passage" })
    );
    const result = await runQueryFile({ query: "growth", broaden: true });
    expect(result.status).toBe("success");
    expect(result.summary).toContain("report.pdf");
    expect(result.summary).toContain("3 keyword match(es)");
    expect(result.summary).toContain("broadened");
    expect(result.summary).toContain("the relevant passage");
  });

  it("reports semantic mode when the corpus query ran semantically", async () => {
    mockExec.mockResolvedValue(
      exec({ active: true, fileName: "proj", sourceType: "folder", matchCount: 5, mode: "semantic", rendered: "[src/x.ts] code" })
    );
    const result = await runQueryFile({ query: "how is auth handled" });
    expect(result.summary).toContain("5 semantic match(es)");
  });

  it("flags zero matches as partial with a broaden hint", async () => {
    mockExec.mockResolvedValue(exec({ active: true, fileName: "x.txt", matchCount: 0, rendered: "" }));
    const result = await runQueryFile({ query: "nonexistent" });
    expect(result.status).toBe("partial");
    expect(result.warnings.join(" ")).toMatch(/broader/i);
  });
});
