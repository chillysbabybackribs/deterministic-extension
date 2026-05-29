import { describe, expect, it } from "vitest";
import { createPagePlanningContext } from "./pagePlanningContext";
import type { ActionableElement, OverlayCaptureResult } from "../../tools/elementOverlay";

function el(index: number, over: Partial<ActionableElement> = {}): ActionableElement {
  return {
    index,
    tagName: over.tagName ?? "button",
    type: over.type,
    role: over.role ?? "button",
    roleSource: over.roleSource ?? "implicit",
    accessibleName: over.accessibleName,
    accessibleNameSource: over.accessibleName ? "text" : "none",
    bounds: { x: 0, y: 0, width: 10, height: 10, pageX: 0, pageY: 0 },
    inViewport: true,
    isVisible: true,
    isEnabled: true,
    matchedBy: over.matchedBy ?? "button",
    attributes: over.attributes ?? { hasHref: false, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
    link: over.link,
    ...over
  };
}

function link(index: number, name: string, href: string, path: string): ActionableElement {
  return el(index, {
    tagName: "a",
    role: "link",
    accessibleName: name,
    attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
    link: {
      href,
      path,
      origin: "https://example.com",
      rel: "same-origin",
      target: undefined,
      isDownload: false,
      kind: "navigation"
    }
  });
}

function capture(elements: ActionableElement[], url = "https://example.com/docs"): OverlayCaptureResult {
  return {
    url,
    title: "Docs",
    viewport: {
      width: 1200,
      height: 800,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 1200,
      documentHeight: 1800
    },
    elements,
    candidateCount: elements.length,
    droppedByDedup: 0,
    warnings: []
  };
}

describe("createPagePlanningContext", () => {
  it("drafts a full click-and-understand workflow for generic navigation requests", () => {
    const context = createPagePlanningContext({
      userMessage: "Click a navigation link on this page, then tell me what changed",
      capture: capture([
        link(1, "Documentation", "https://example.com/docs", "/docs"),
        el(2, { accessibleName: "More actions" }),
        link(3, "Web search", "https://example.com/docs/web", "/docs/web")
      ])
    });

    expect(context.draftSteps).toHaveLength(2);
    expect(context.draftSteps[0]).toMatchObject({
      tool: "act_on_page",
      args: { steps: [{ action: "click", target: { overlayIndex: 3 } }] }
    });
    expect(context.draftSteps[1]).toMatchObject({ tool: "understand_page", args: {} });
    expect(context.plannerText).toContain("Target candidates");
    expect(context.plannerText).toContain("#3 link \"Web search\"");
    expect(context.plannerText).toContain("Draft workflow JSON steps");
  });

  it("drafts understand_page with the matched link URL when asked to read a link", () => {
    const context = createPagePlanningContext({
      userMessage: "Read the pricing link on this page",
      capture: capture([
        link(1, "Docs", "https://example.com/docs", "/docs"),
        link(2, "Pricing", "https://example.com/pricing", "/pricing")
      ])
    });

    expect(context.draftSteps).toEqual([{
      tool: "understand_page",
      args: { url: "https://example.com/pricing" },
      rationale: "Open and read the matched link \"Pricing\"."
    }]);
    expect(context.plannerText).toContain("understand_page {\"url\":\"https://example.com/pricing\"}");
  });

  it("drafts a current-page understanding step for current page read prompts", () => {
    const context = createPagePlanningContext({
      userMessage: "What is this page?",
      capture: capture([link(1, "Pricing", "https://example.com/pricing", "/pricing")])
    });

    expect(context.draftSteps).toMatchObject([{ tool: "understand_page", args: {} }]);
    expect(context.plannerText).toContain("Parsed user/page intent: no specific page action target detected.");
    expect(context.logSummary).toContain("draft understand_page");
  });

  it("includes recalled corpus targets in the planner packet when provided", () => {
    const context = createPagePlanningContext({
      userMessage: "go to checkout",
      capture: capture([link(1, "Home", "https://example.com/", "/")]),
      recalledText: "Relevant interaction targets recalled from this site's accumulated map:\n- link \"Checkout\" → /checkout (on https://example.com/cart)"
    });
    expect(context.plannerText).toContain("recalled from this site's accumulated map");
    expect(context.plannerText).toContain("\"Checkout\" → /checkout");
    // Surfaced in the activity log summary so it's visible in the Activity panel.
    expect(context.logSummary).toContain("recalled 1 target(s) from site map");
  });

  it("omits the recall section when no recalled text is provided", () => {
    const context = createPagePlanningContext({
      userMessage: "What is this page?",
      capture: capture([link(1, "Home", "https://example.com/", "/")])
    });
    expect(context.plannerText).not.toContain("recalled from this site's accumulated map");
  });

  it("keeps ambiguous non-generic action requests as a shortlist without unsafe action draft", () => {
    const context = createPagePlanningContext({
      userMessage: "Click edit",
      capture: capture([
        el(1, { accessibleName: "Edit" }),
        el(2, { accessibleName: "Edit" })
      ])
    });

    expect(context.draftSteps).toHaveLength(0);
    expect(context.plannerText).toContain("target shortlist only");
    expect(context.plannerText).toContain("#1 button \"Edit\"");
    expect(context.plannerText).toContain("#2 button \"Edit\"");
  });
});
