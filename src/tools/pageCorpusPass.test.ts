import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./elementOverlay", () => ({
  showActionableOverlay: vi.fn()
}));

import { showActionableOverlay, type ActionableElement, type OverlayCaptureResult } from "./elementOverlay";
import { runPageCorpusPass } from "./pageCorpusPass";

const mockShow = vi.mocked(showActionableOverlay);

function el(index: number, accessibleName: string): ActionableElement {
  return {
    index,
    tagName: "a",
    role: "link",
    roleSource: "implicit",
    accessibleName,
    accessibleNameSource: "text",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    inViewport: true,
    isVisible: true,
    isEnabled: true,
    matchedBy: "test",
    attributes: {}
  } as ActionableElement;
}

function capture(elements: ActionableElement[]): OverlayCaptureResult {
  return {
    url: "https://example.com",
    title: "Example",
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0, documentWidth: 800, documentHeight: 600 },
    elements,
    candidateCount: elements.length,
    droppedByDedup: 0,
    warnings: []
  };
}

beforeEach(() => {
  mockShow.mockReset();
});

describe("runPageCorpusPass", () => {
  it("returns skipped (never throws) when the overlay cannot run", async () => {
    mockShow.mockRejectedValue(new Error("chrome:// page"));
    const outcome = await runPageCorpusPass({ target: "anything" });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toContain("chrome://");
    }
  });

  it("captures the corpus and finds a unique exact match for the target", async () => {
    mockShow.mockResolvedValue(capture([el(1, "Sign in"), el(2, "Pricing"), el(3, "Docs")]));
    const outcome = await runPageCorpusPass({ target: "sign in" });
    expect(outcome.kind).toBe("captured");
    if (outcome.kind === "captured") {
      expect(outcome.exact?.index).toBe(1);
      expect(outcome.summary).toContain("Exact match");
      expect(outcome.summary).toContain("Mapped 3 actionable element(s)");
    }
  });

  it("returns a shortlist (no exact) when the target is ambiguous", async () => {
    mockShow.mockResolvedValue(capture([el(1, "Sign in"), el(2, "Sign in with Google")]));
    const outcome = await runPageCorpusPass({ target: "sign" });
    expect(outcome.kind).toBe("captured");
    if (outcome.kind === "captured") {
      expect(outcome.exact).toBeUndefined();
      expect(outcome.shortlist.length).toBeGreaterThan(0);
      expect(outcome.summary).toContain("candidates");
    }
  });

  it("paints + maps the page with no grep result when no target is given", async () => {
    mockShow.mockResolvedValue(capture([el(1, "Home"), el(2, "About")]));
    const outcome = await runPageCorpusPass({});
    expect(outcome.kind).toBe("captured");
    if (outcome.kind === "captured") {
      expect(outcome.exact).toBeUndefined();
      expect(outcome.shortlist).toEqual([]);
      expect(outcome.summary).toContain("Actionable map");
      expect(outcome.summary).not.toContain("Exact match");
    }
  });
});
