import { describe, expect, it } from "vitest";
import { addCapturedUiIntelligenceProfiles, type CapturedUiReference } from "./pageCapture";
import { planComponentTemplate } from "./componentTemplatePlanner";

describe("deterministic component template planner", () => {
  it("plans captured buttons into concrete Button template instructions", () => {
    const capture = addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "button",
        textPreview: "Try Claude",
        accessibleName: "Try Claude",
        type: "button",
        disabled: false,
        selector: "button[data-testid=\"cta\"]",
        selectorConfidence: "high",
        computedStyle: {
          display: "inline-flex",
          position: "relative",
          color: "rgb(250, 249, 245)",
          backgroundColor: "rgb(20, 20, 20)",
          fontFamily: "Inter, sans-serif",
          fontSize: "16px",
          fontWeight: "700",
          lineHeight: "24px",
          padding: "12px 16px 12px 16px",
          margin: "0px 0px 0px 0px",
          border: "1px solid rgb(20, 20, 20)",
          borderRadius: "10px",
          boxShadow: "none"
        }
      },
      profiles: {
        accessibility: {
          role: "button",
          accessibleName: "Try Claude",
          focusable: true,
          issues: []
        }
      }
    }));

    expect(planComponentTemplate(capture)).toMatchObject({
      template: "Button",
      sourceKind: "button",
      confidence: "high",
      selector: "button[data-testid=\"cta\"]",
      props: {
        children: "Try Claude",
        type: "button",
        disabled: false
      },
      styleTokensWanted: {
        bg: "#141414",
        fg: "#faf9f5",
        radius: "10px",
        padding: "12px 16px 12px 16px",
        fontFamily: "Inter",
        fontSize: "16px",
        fontWeight: "700"
      },
      layoutTokensWanted: {
        display: "inline-flex",
        position: "relative"
      },
      requiredPrimitives: ["Button"],
      warnings: []
    });
  });

  it("plans links with href and local Link primitive requirements", () => {
    const capture = addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "a",
        textPreview: "Pricing",
        accessibleName: "Pricing",
        href: "/pricing",
        selector: "a[href=\"/pricing\"]",
        selectorConfidence: "high"
      }
    }));

    expect(planComponentTemplate(capture)).toMatchObject({
      template: "Link",
      intent: "navigation",
      props: {
        children: "Pricing",
        href: "/pricing"
      },
      requiredPrimitives: ["Link"]
    });
  });

  it("plans inputs with form state and accessible labels", () => {
    const capture = addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "input",
        accessibleName: "Email",
        placeholder: "Email",
        valuePreview: "person@example.com",
        type: "email",
        selector: "input[name=\"email\"]",
        selectorConfidence: "high"
      },
      profiles: {
        accessibility: {
          accessibleName: "Email",
          focusable: true,
          required: true,
          issues: []
        }
      }
    }));

    expect(planComponentTemplate(capture)).toMatchObject({
      template: "Input",
      intent: "input",
      props: {
        name: "email",
        type: "email",
        placeholder: "Email",
        defaultValue: "person@example.com",
        "aria-label": "Email"
      },
      requiredPrimitives: ["Input"]
    });
  });

  it("plans cards with layout token requests and Card primitive requirements", () => {
    const capture = addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "div",
        textPreview: "Pro plan $20/month",
        selector: "div.pricing-card",
        selectorConfidence: "medium",
        computedStyle: {
          display: "grid",
          position: "relative",
          color: "rgb(17, 17, 17)",
          backgroundColor: "rgb(255, 255, 255)",
          fontFamily: "Inter, sans-serif",
          fontSize: "16px",
          fontWeight: "400",
          lineHeight: "24px",
          padding: "24px 24px 24px 24px",
          margin: "0px 0px 0px 0px",
          border: "1px solid rgb(229, 231, 235)",
          borderRadius: "16px",
          boxShadow: "rgba(0, 0, 0, 0.12) 0px 12px 32px"
        }
      },
      profiles: {
        layoutContext: {
          parent: {
            tagName: "section",
            selector: "section:nth-of-type(1)",
            selectorConfidence: "low",
            display: "grid",
            bounds: { x: 0, y: 0, width: 960, height: 400 }
          },
          nearestSemanticContainer: {
            tagName: "section",
            selector: "section:nth-of-type(1)",
            selectorConfidence: "low",
            display: "grid",
            bounds: { x: 0, y: 0, width: 960, height: 400 }
          },
          previousSiblings: [],
          nextSiblings: [],
          children: [],
          childCount: 3,
          siblingCount: 2
        }
      }
    }));

    expect(planComponentTemplate(capture)).toMatchObject({
      template: "Card",
      props: {
        children: "Pro plan $20/month",
        childCount: 3
      },
      styleTokensWanted: {
        bg: "#ffffff",
        fg: "#111111",
        border: "1px solid rgb(229, 231, 235)",
        radius: "16px",
        shadow: "rgba(0, 0, 0, 0.12) 0px 12px 32px"
      },
      layoutTokensWanted: {
        display: "grid",
        position: "relative",
        parentDisplay: "grid",
        childCount: 3,
        siblingCount: 2
      },
      requiredPrimitives: ["Card"]
    });
  });

  it("returns a low-confidence fallback when no component profile exists", () => {
    const capture = captureFixture({
      element: {
        tagName: "div",
        textPreview: "Mystery",
        selector: "div:nth-of-type(4)",
        selectorConfidence: "low"
      }
    });

    expect(planComponentTemplate(capture)).toMatchObject({
      template: "Unknown",
      sourceKind: "unknown",
      confidence: "low",
      props: {},
      requiredPrimitives: [],
      warnings: ["component profile is missing"]
    });
  });
});

function captureFixture(args: {
  element: Partial<CapturedUiReference["element"]> & Pick<CapturedUiReference["element"], "tagName" | "selector" | "selectorConfidence">;
  profiles?: CapturedUiReference["profiles"];
}): CapturedUiReference {
  const element: CapturedUiReference["element"] = {
    id: undefined,
    classNames: [],
    dataAttributes: {},
    bounds: {
      x: 10,
      y: 20,
      width: 120,
      height: 84
    },
    computedStyle: {
      display: "inline-flex",
      position: "static",
      color: "rgb(250, 249, 245)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      fontFamily: "Anthropic Sans, sans-serif",
      fontSize: "20px",
      fontWeight: "400",
      lineHeight: "24px",
      padding: "0px 0px 0px 0px",
      margin: "0px 0px 0px 0px",
      border: "0px none rgb(250, 249, 245)",
      borderRadius: "0px",
      boxShadow: "none"
    },
    ...args.element
  };

  return {
    captureId: "ui_test",
    url: "https://claude.ai/use-cases",
    title: "Claude - Use cases page",
    viewport: {
      width: 1280,
      height: 800,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0
    },
    pointer: {
      clientX: 30,
      clientY: 40,
      pageX: 30,
      pageY: 40
    },
    element,
    profiles: args.profiles
  };
}
