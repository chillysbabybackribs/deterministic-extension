import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserToolExecution } from "../browserToolExecutor";

vi.mock("../browserToolExecutor", () => ({
  executeBrowserTool: vi.fn()
}));
vi.mock("../../background/deterministicNetworkCaptureRunner", () => ({
  runDeterministicNetworkCapturePreflight: vi.fn(),
  formatDeterministicNetworkCaptureForLlm: vi.fn(() => "NETWORK SUMMARY: 3 endpoints")
}));
vi.mock("../elementOverlay", () => ({
  showActionableOverlay: vi.fn(async () => ({
    url: "https://x/", title: "X", viewport: {},
    elements: [
      { index: 1, tagName: "input", role: "textbox", roleSource: "implicit", accessibleName: "Email", accessibleNameSource: "label-element", inViewport: true, isVisible: true, isEnabled: true, matchedBy: "input", attributes: {} },
      { index: 2, tagName: "a", role: "link", roleSource: "implicit", accessibleName: "Settings", accessibleNameSource: "text", inViewport: true, isVisible: true, isEnabled: true, matchedBy: "a[href]", attributes: { hasHref: true }, link: { href: "https://x/settings", path: "/settings", origin: "https://x", rel: "same-origin", isDownload: false, kind: "navigation" } }
    ],
    candidateCount: 2, droppedByDedup: 0, warnings: []
  })),
  hideActionableOverlay: vi.fn(async () => undefined)
}));
vi.mock("../pageReadiness", () => ({
  waitForPageReadyForExtraction: vi.fn(async () => ({
    ok: true,
    elapsedMs: 120,
    samples: 3,
    reason: "test",
    warnings: []
  }))
}));

import { executeBrowserTool } from "../browserToolExecutor";
import {
  runDeterministicNetworkCapturePreflight
} from "../../background/deterministicNetworkCaptureRunner";
import { runUnderstandPage } from "./understandPage";
import { runCaptureNetworkFat } from "./captureNetwork";
import { runSearchWeb } from "./searchWeb";
import { runReadWorkspace } from "./readWorkspace";
import { runActOnPage } from "./actOnPage";
import { runWriteWorkspace } from "./writeWorkspace";
import { FAT_SUMMARY_MAX_CHARS } from "./fatToolTypes";
import { resetResearchTab, setResearchTabId } from "../researchTab";
import { showActionableOverlay } from "../elementOverlay";
import type { OverlayCaptureResult } from "../elementOverlay";
import { waitForPageReadyForExtraction } from "../pageReadiness";

function exec(overrides: Partial<BrowserToolExecution> = {}): BrowserToolExecution {
  return {
    callId: "c", toolName: "t", status: "success", output: {}, warnings: [], summary: "ok",
    activity: {} as never, stepResult: {} as never, toolResult: {} as never,
    evidenceItems: [], failures: [], searchCandidates: [], openedSources: [],
    extractedSections: [], extractedTextSample: "", prunedTabIds: [], groupedTabIds: [],
    visibleActions: [], ...overrides
  };
}

const mockExec = vi.mocked(executeBrowserTool);
const mockWaitForReady = vi.mocked(waitForPageReadyForExtraction);
afterEach(() => vi.clearAllMocks());

describe("understand_page", () => {
  it("composes 4 tools and returns compact summary + full extraction", async () => {
    mockExec
      .mockResolvedValueOnce(exec({ output: { tab: { title: "WeTransfer", url: "https://wetransfer.com" } } }))
      .mockResolvedValueOnce(exec({ output: { inspection: {
        frameworkHints: ["Next.js"],
        domSummary: { totalElements: 600, forms: [{}], interactiveElements: [{}, {}] },
        network: { resourceCountsByType: { fetch: 12 } },
        storage: { localStorage: [{ key: "a" }, { key: "b" }] }
      } } }))
      .mockResolvedValueOnce(exec({ output: { observation: { elements: [{ role: "button", name: "Send" }] } } }))
      .mockResolvedValueOnce(exec({ output: { page: { headings: ["Send files"], text: "Upload and share" } } }));

    const r = await runUnderstandPage({ tabId: 1 });
    expect(mockExec).toHaveBeenCalledTimes(4);
    expect(mockWaitForReady).toHaveBeenCalledWith(1, expect.objectContaining({ reason: "understand_page" }));
    expect(r.status).toBe("success");
    expect(r.summary).toContain("WeTransfer");
    expect(r.summary).toContain("Next.js");
    expect(r.summary).toContain("Send");
    expect(r.summary.length).toBeLessThanOrEqual(FAT_SUMMARY_MAX_CHARS);
    // full extraction keeps everything
    expect(r.fullExtraction).toHaveProperty("tab");
    expect(r.fullExtraction).toHaveProperty("inspection");
    expect(r.fullExtraction).toHaveProperty("observation");
    expect(r.fullExtraction).toHaveProperty("extraction");
  });

  it("reports failed only when every sub-tool fails", async () => {
    mockExec.mockResolvedValue(exec({ status: "failed", error: "no tab" }));
    const r = await runUnderstandPage();
    expect(r.status).toBe("failed");
  });

  it("opens a NEW tab for a url when there is no research tab yet, then understands it", async () => {
    resetResearchTab(); // fresh task: no research tab
    mockExec
      // browser_open_tab → returns the opened tab id
      .mockResolvedValueOnce(exec({ output: { tab: { id: 42, url: "https://tokio.rs/", title: "Tokio" } } }))
      // the 4 understanding sub-tools
      .mockResolvedValueOnce(exec({ output: { tab: { title: "Tokio", url: "https://tokio.rs/" } } }))
      .mockResolvedValueOnce(exec({ output: { inspection: {} } }))
      .mockResolvedValueOnce(exec({ output: { observation: {} } }))
      .mockResolvedValueOnce(exec({ output: { page: { text: "async runtime" } } }));

    const r = await runUnderstandPage({ url: "https://tokio.rs/" });

    // First call opens a new tab (no research tab to reuse), active.
    expect(mockExec.mock.calls[0][0]).toMatchObject({ name: "browser_open_tab", input: { url: "https://tokio.rs/", active: true } });
    expect(mockExec.mock.calls[1][0]).toMatchObject({ name: "browser_read_active_tab", input: { tabId: 42 } });
    expect(mockExec).toHaveBeenCalledTimes(5);
    expect(r.tool).toBe("understand_page");
  });

  it("NAVIGATES the existing research tab (single tab per task) instead of opening a new one", async () => {
    resetResearchTab();
    setResearchTabId(7); // search_web already opened tab 7 this task
    mockExec
      // browser_navigate_active_tab → navigates tab 7 to the result url
      .mockResolvedValueOnce(exec({ output: { tab: { id: 7, url: "https://async.rs/", title: "async-std" } } }))
      .mockResolvedValueOnce(exec({ output: { tab: { title: "async-std", url: "https://async.rs/" } } }))
      .mockResolvedValueOnce(exec({ output: { inspection: {} } }))
      .mockResolvedValueOnce(exec({ output: { observation: {} } }))
      .mockResolvedValueOnce(exec({ output: { page: { text: "another runtime" } } }));

    await runUnderstandPage({ url: "https://async.rs/" });

    // No new tab — it navigates the SAME research tab (7) and activates it.
    expect(mockExec.mock.calls[0][0]).toMatchObject({
      name: "browser_navigate_active_tab",
      input: { action: "go_to", url: "https://async.rs/", tabId: 7 }
    });
    // Understanding targets that same tab.
    expect(mockExec.mock.calls[1][0]).toMatchObject({ name: "browser_read_active_tab", input: { tabId: 7 } });
  });
});

describe("capture_network", () => {
  it("wraps the deterministic runner into the fat shape", async () => {
    vi.mocked(runDeterministicNetworkCapturePreflight).mockResolvedValue({
      bundle: { id: "n", tabId: 1, startedAt: "", completedAt: "", status: "completed", capturing: false, reloaded: true, captureBlocked: false, blockedReason: "", bodiesUnobtainable: false, warnings: [], errors: [] },
      activity: []
    });
    const r = await runCaptureNetworkFat({ tabId: 1 });
    expect(r.tool).toBe("capture_network");
    expect(r.status).toBe("success");
    expect(r.summary).toContain("NETWORK SUMMARY");
    expect(r.fullExtraction).toHaveProperty("bundle");
  });
});

describe("search_web", () => {
  it("extracts clean candidate result links and surfaces them", async () => {
    mockExec.mockResolvedValueOnce(exec({ output: {
      tab: { url: "https://www.google.com/search?q=x" },
      snapshot: {
        headings: ["Result A"],
        text: "snippet text",
        links: [
          { text: "Tokio — async Rust", url: "https://tokio.rs/" },
          { text: "Privacy", url: "https://policies.google.com/privacy" }, // utility, dropped
          { text: "async-std", url: "https://async.rs/" }
        ]
      }
    } }));
    const r = await runSearchWeb({ query: "rust async" });
    expect(r.summary).toContain("rust async");
    // Real result links surface as candidates; Google utility links are filtered out.
    expect(r.summary).toContain("https://tokio.rs/");
    expect(r.summary).toContain("https://async.rs/");
    expect(r.summary).not.toContain("policies.google.com");
    expect(r.fullExtraction).toHaveProperty("output");
    expect(r.fullExtraction).toHaveProperty("candidates");
    expect(Array.isArray((r.fullExtraction as { candidates: unknown[] }).candidates)).toBe(true);
  });
});

describe("read_workspace", () => {
  it("partial when no folder connected, with helpful warning", async () => {
    mockExec.mockResolvedValueOnce(exec({ output: { workspace: { connected: false } } }));
    const r = await runReadWorkspace();
    expect(mockExec).toHaveBeenCalledTimes(1); // only status when disconnected
    expect(r.status).toBe("partial");
    expect(r.warnings.join(" ")).toContain("No workspace folder is connected");
  });

  it("gathers listing + search when connected", async () => {
    mockExec
      .mockResolvedValueOnce(exec({ output: { workspace: { connected: true, rootName: "proj", readPermission: "granted", writeEnabled: true, writePermission: "granted" } } }))
      .mockResolvedValueOnce(exec({ output: { entries: [{ path: "src/a.ts" }, { path: "README.md" }] } }))
      .mockResolvedValueOnce(exec({ output: { matches: [{ path: "src/a.ts", line: 4, preview: "foo" }] } }));
    const r = await runReadWorkspace({ query: "foo" });
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(r.summary).toContain("proj");
    expect(r.summary).toContain("src/a.ts");
    expect(r.summary).toContain('Matches for "foo"');
    expect(r.fullExtraction).toHaveProperty("listing");
    expect(r.fullExtraction).toHaveProperty("search");
  });
});

describe("act_on_page", () => {
  it("observes, performs steps, observes after", async () => {
    mockExec
      .mockResolvedValueOnce(exec({ output: { observation: { elements: [] } } })) // before
      .mockResolvedValueOnce(exec({ summary: "Clicked Send" })) // click
      .mockResolvedValueOnce(exec({ output: { observation: { title: "Sent", url: "https://x/done" } } })); // after
    const r = await runActOnPage({ steps: [{ action: "click", target: { text: "Send" } }] });
    expect(r.status).toBe("success");
    expect(r.summary).toContain("1 of 1 interaction");
    expect(r.summary).toContain("Sent");
    expect(r.fullExtraction).toHaveProperty("before");
    expect(r.fullExtraction).toHaveProperty("after");
    // The actionable overlay is captured FIRST, mandatory, before acting.
    expect(r.summary).toContain("Mapped 2 actionable element(s) before acting");
    expect((r.fullExtraction as { actionableMap?: { elements: unknown[] } }).actionableMap?.elements).toHaveLength(2);
    // The map is rendered legibly with names, and link destinations are surfaced.
    expect(r.summary).toContain("#1 textbox \"Email\"");
    expect(r.summary).toContain("#2 link \"Settings\" → /settings");
  });

  it("reuses a freshly prefetched actionable map without repainting the overlay", async () => {
    const prefetchedActionableMap: OverlayCaptureResult = {
      url: "https://x/",
      title: "X",
      viewport: {
        width: 1200,
        height: 800,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        documentWidth: 1200,
        documentHeight: 1600
      },
      elements: [{
        index: 1,
        tagName: "button",
        role: "button",
        roleSource: "implicit",
        accessibleName: "Send",
        accessibleNameSource: "text",
        bounds: { x: 0, y: 0, width: 80, height: 32, pageX: 0, pageY: 0 },
        inViewport: true,
        isVisible: true,
        isEnabled: true,
        matchedBy: "button",
        attributes: { hasHref: false, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false }
      }],
      candidateCount: 1,
      droppedByDedup: 0,
      warnings: []
    };
    mockExec
      .mockResolvedValueOnce(exec({ output: { observation: { elements: [] } } }))
      .mockResolvedValueOnce(exec({ summary: "Clicked Send" }))
      .mockResolvedValueOnce(exec({ output: { observation: { title: "Sent", url: "https://x/done" } } }));

    const r = await runActOnPage({
      steps: [{ action: "click", target: { text: "Send" } }],
      prefetchedActionableMap
    });

    expect(showActionableOverlay).not.toHaveBeenCalled();
    expect(r.summary).toContain("Mapped 1 actionable element(s) before acting");
    expect(r.summary).toContain("#1 button \"Send\"");
  });

  it("reuses a fresh prefetched before observation before acting", async () => {
    const prefetchedBefore = exec({ output: { tab: { url: "https://x/" }, observation: { title: "Before", url: "https://x/", elements: [] } } });
    mockExec
      .mockResolvedValueOnce(exec({ summary: "Clicked Send" }))
      .mockResolvedValueOnce(exec({ output: { observation: { title: "Sent", url: "https://x/done" } } }));

    const r = await runActOnPage({
      steps: [{ action: "click", target: { text: "Send" } }],
      prefetchedActionableMap: { url: "https://x/", title: "X", viewport: {}, elements: [], candidateCount: 0, droppedByDedup: 0, warnings: [] } as unknown as OverlayCaptureResult,
      prefetchedBeforeObservation: {
        startedAtMs: Date.now(),
        promise: Promise.resolve(prefetchedBefore)
      }
    });

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][0]).toMatchObject({ name: "browser_click" });
    expect((r.fullExtraction as { before?: unknown }).before).toBe(prefetchedBefore.output);
  });

  it("falls back to a just-in-time before observation when the prefetch is stale", async () => {
    const prefetchedBefore = exec({ output: { tab: { url: "https://x/" }, observation: { title: "Before", url: "https://x/", elements: [] } } });
    mockExec
      .mockResolvedValueOnce(exec({ output: { observation: { elements: [] } } }))
      .mockResolvedValueOnce(exec({ summary: "Clicked Send" }))
      .mockResolvedValueOnce(exec({ output: { observation: { title: "Sent", url: "https://x/done" } } }));

    await runActOnPage({
      steps: [{ action: "click", target: { text: "Send" } }],
      prefetchedActionableMap: { url: "https://x/", title: "X", viewport: {}, elements: [], candidateCount: 0, droppedByDedup: 0, warnings: [] } as unknown as OverlayCaptureResult,
      prefetchedBeforeObservation: {
        startedAtMs: Date.now() - 60_000,
        promise: Promise.resolve(prefetchedBefore)
      }
    });

    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec.mock.calls[0][0]).toMatchObject({ name: "browser_observe_page" });
  });

  it("stops on first failed step and reports partial/failed", async () => {
    mockExec
      .mockResolvedValueOnce(exec({ output: { observation: {} } })) // before
      .mockResolvedValueOnce(exec({ status: "failed", error: "target not found" })) // click fails
      .mockResolvedValueOnce(exec({ output: { observation: {} } })); // after
    const r = await runActOnPage({ steps: [{ action: "click", target: { text: "Nope" } }] });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("target not found");
  });

  it("fails fast with no steps", async () => {
    const r = await runActOnPage({ steps: [] });
    expect(r.status).toBe("failed");
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("write_workspace", () => {
  it("writes a named file and confirms", async () => {
    mockExec.mockResolvedValueOnce(exec({ output: { path: "notes.md" } }));
    const r = await runWriteWorkspace({ path: "notes.md", content: "# hi" });
    expect(r.status).toBe("success");
    expect(r.summary).toContain("Wrote notes.md");
  });

  it("fails fast with no path", async () => {
    const r = await runWriteWorkspace({ path: "", content: "x" });
    expect(r.status).toBe("failed");
    expect(mockExec).not.toHaveBeenCalled();
  });
});
