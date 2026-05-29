import { describe, expect, it } from "vitest";
import {
  addCapturedUiIntelligenceProfiles,
  type CapturedUiReference,
  formatCapturedUiDisplaySummary,
  formatCapturedUiDisplayText,
  formatCapturedUiReferenceForRequest
} from "./pageCapture";

describe("captured UI display formatting", () => {
  it("summarizes promoted SVG link captures without exposing raw JSON in visible text", () => {
    const summary = formatCapturedUiDisplaySummary(captureFixture({
      element: {
        tagName: "a",
        role: "link",
        ariaLabel: "Home page",
        href: "/",
        selector: "a[aria-label=\"Home page\"]",
        selectorConfidence: "high"
      },
      hitElement: {
        tagName: "path",
        selector: "a[aria-label=\"Home page\"] > svg > path:nth-of-type(1)",
        selectorConfidence: "medium"
      }
    }));
    const visibleText = formatCapturedUiDisplayText(summary);

    expect(summary.elementDescription).toBe("Home page link");
    expect(summary.hitElement).toBe("<path> inside SVG, promoted to <a>");
    expect(visibleText).toContain("Captured UI: <a> Home page link");
    expect(visibleText).not.toContain("computedStyle");
    expect(visibleText).not.toContain("```json");
  });

  it("uses placeholders and input identity for input captures", () => {
    const summary = formatCapturedUiDisplaySummary(captureFixture({
      element: {
        tagName: "input",
        placeholder: "Email",
        name: "email",
        type: "email",
        selector: "input[name=\"email\"]",
        selectorConfidence: "high"
      }
    }));

    expect(summary.elementDescription).toBe("Email input");
    expect(summary.semanticContext).toBe("Name: email");
  });

  it("surfaces deterministic component IR in the capture display summary", () => {
    const summary = formatCapturedUiDisplaySummary(addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "button",
        textPreview: "Try Claude",
        accessibleName: "Try Claude",
        type: "button",
        selector: "button[data-testid=\"cta\"]",
        selectorConfidence: "high"
      }
    })));

    expect(summary.component).toMatchObject({
      kind: "button",
      intent: "action",
      confidence: "high",
      templateHints: expect.arrayContaining(["prefer local Button primitive when available"])
    });
  });

  it("keeps the full capture JSON in active request context", () => {
    const context = formatCapturedUiReferenceForRequest(captureFixture({
      element: {
        tagName: "button",
        textPreview: "Try Claude",
        selector: "button:nth-of-type(1)",
        selectorConfidence: "low"
      }
    }));

    expect(context).toContain("The user recently captured a UI element from the browser.");
    expect(context).toContain("computedStyle");
    expect(context).toContain("Try Claude");
  });

  it("keeps layout context in active request context when present", () => {
    const context = formatCapturedUiReferenceForRequest({
      ...captureFixture({
        element: {
          tagName: "button",
          textPreview: "Try Claude",
          selector: "button:nth-of-type(1)",
          selectorConfidence: "low"
        }
      }),
      profiles: {
        layoutContext: {
          parent: {
            tagName: "nav",
            role: "navigation",
            selector: "nav[aria-label=\"Primary\"]",
            selectorConfidence: "high",
            bounds: { x: 0, y: 0, width: 800, height: 72 },
            display: "flex",
            gap: "16px",
            alignItems: "center",
            justifyContent: "space-between"
          },
          nearestSemanticContainer: {
            tagName: "header",
            selector: "header:nth-of-type(1)",
            selectorConfidence: "low",
            bounds: { x: 0, y: 0, width: 800, height: 72 },
            display: "block"
          },
          previousSiblings: [],
          nextSiblings: [{
            tagName: "a",
            label: "Pricing",
            selector: "a[href=\"/pricing\"]",
            selectorConfidence: "high",
            bounds: { x: 130, y: 20, width: 80, height: 32 },
            display: "inline-flex"
          }],
          children: [],
          childCount: 0,
          siblingCount: 3
        }
      }
    });

    expect(context).toContain("layoutContext");
    expect(context).toContain("nav[aria-label=\\\"Primary\\\"]");
    expect(context).toContain("Pricing");
  });

  it("keeps asset profile clues in active request context when present", () => {
    const context = formatCapturedUiReferenceForRequest({
      ...captureFixture({
        element: {
          tagName: "img",
          alt: "Dashboard preview",
          src: "https://example.com/dashboard.webp",
          selector: "img[alt=\"Dashboard preview\"]",
          selectorConfidence: "high"
        }
      }),
      profiles: {
        assets: {
          images: [{
            src: "https://example.com/dashboard.webp",
            alt: "Dashboard preview",
            selector: "img[alt=\"Dashboard preview\"]",
            selectorConfidence: "high",
            bounds: { x: 10, y: 20, width: 320, height: 180 }
          }],
          svgs: [{
            selector: "svg:nth-of-type(1)",
            selectorConfidence: "low",
            bounds: { x: 0, y: 0, width: 24, height: 24 },
            ariaLabel: "Arrow right",
            iconLike: true
          }],
          backgroundImages: [{
            url: "https://example.com/bg.png",
            selector: "section:nth-of-type(1)",
            selectorConfidence: "low"
          }],
          videos: []
        }
      }
    });

    expect(context).toContain("assets");
    expect(context).toContain("Dashboard preview");
    expect(context).toContain("https://example.com/bg.png");
    expect(context).toContain("iconLike");
    expect(context).not.toContain("\"videos\": []");
  });

  it("keeps accessibility profile clues in active request context when present", () => {
    const context = formatCapturedUiReferenceForRequest({
      ...captureFixture({
        element: {
          tagName: "button",
          textPreview: "Submit",
          role: "button",
          accessibleName: "Submit",
          selector: "button:nth-of-type(1)",
          selectorConfidence: "low"
        }
      }),
      profiles: {
        accessibility: {
          role: "button",
          accessibleName: "Submit",
          focusable: true,
          contrast: {
            foreground: "#111111",
            background: "#ffffff",
            ratio: 18.88,
            passesAA: true
          },
          issues: []
        }
      }
    });

    expect(context).toContain("accessibility");
    expect(context).toContain("focusable");
    expect(context).toContain("passesAA");
    expect(context).toContain("Submit");
  });

  it("keeps source/page clues in active request context when present", () => {
    const context = formatCapturedUiReferenceForRequest({
      ...captureFixture({
        element: {
          tagName: "button",
          textPreview: "Try Claude",
          selector: "button:nth-of-type(1)",
          selectorConfidence: "low"
        }
      }),
      profiles: {
        sourceClues: {
          documentLanguage: "en",
          colorScheme: "light dark",
          metaGenerator: "Next.js",
          frameworkHints: ["Next.js", "React"],
          componentLibraryHints: ["utility CSS classes"],
          cssFiles: ["https://example.com/_next/static/css/app.css"],
          fontFamilies: ["Inter"],
          cssVariables: [{
            name: "--brand-bg",
            value: "#faf9f5",
            source: "root"
          }],
          scriptHints: ["https://example.com/_next/static/chunks/app.js"]
        }
      }
    });

    expect(context).toContain("sourceClues");
    expect(context).toContain("Next.js");
    expect(context).toContain("--brand-bg");
    expect(context).toContain("_next/static/css/app.css");
  });

  it("adds a compact deterministic style profile for LLM context", () => {
    const capture = addCapturedUiIntelligenceProfiles(captureFixture({
      element: {
        tagName: "button",
        textPreview: "Try Claude",
        selector: "button:nth-of-type(1)",
        selectorConfidence: "low",
        computedStyle: {
          display: "inline-flex",
          position: "relative",
          color: "rgb(250, 249, 245)",
          backgroundColor: "rgb(20, 20, 20)",
          fontFamily: "Anthropic Sans, sans-serif",
          fontSize: "20px",
          fontWeight: "700",
          lineHeight: "24px",
          padding: "12px 16px 12px 16px",
          margin: "0px 0px 0px 0px",
          border: "1px solid rgb(250, 249, 245)",
          borderRadius: "12px",
          boxShadow: "rgba(0, 0, 0, 0.2) 0px 8px 24px"
        }
      }
    }));

    expect(capture.profiles?.style).toMatchObject({
      typography: {
        fontFamily: "Anthropic Sans",
        fontSize: "20px",
        fontWeight: "700"
      },
      colors: {
        text: "#faf9f5",
        background: "#141414"
      },
      visualTags: expect.arrayContaining(["flex", "filled", "rounded", "shadow", "bordered", "bold"])
    });
  });

  it("builds deterministic component IR for captured buttons", () => {
    const capture = addCapturedUiIntelligenceProfiles({
      ...captureFixture({
        element: {
          tagName: "button",
          textPreview: "Try Claude",
          accessibleName: "Try Claude",
          type: "button",
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
        }
      }),
      profiles: {
        accessibility: {
          role: "button",
          accessibleName: "Try Claude",
          focusable: true,
          issues: []
        }
      }
    });

    expect(capture.profiles?.component).toMatchObject({
      kind: "button",
      intent: "action",
      confidence: "high",
      label: "Try Claude",
      content: {
        text: "Try Claude"
      },
      behavior: {
        type: "button",
        focusable: true
      },
      templateHints: expect.arrayContaining(["prefer local Button primitive when available"])
    });
    expect(capture.profiles?.quality).toMatchObject({
      confidence: "high",
      stableSelector: true,
      promotedTarget: false,
      usableForTemplate: true,
      signals: expect.arrayContaining([
        "high confidence selector",
        "accessible name available",
        "classified as button"
      ])
    });
  });

  it("builds deterministic component IR for card-like containers", () => {
    const capture = addCapturedUiIntelligenceProfiles({
      ...captureFixture({
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
        }
      }),
      profiles: {
        layoutContext: {
          parent: {
            tagName: "section",
            selector: "section:nth-of-type(1)",
            selectorConfidence: "low",
            display: "grid",
            bounds: { x: 0, y: 0, width: 960, height: 400 },
            gap: "24px",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))"
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
          children: [{
            tagName: "h3",
            label: "Pro plan",
            selector: "h3:nth-of-type(1)",
            selectorConfidence: "low",
            bounds: { x: 20, y: 20, width: 200, height: 32 },
            display: "block"
          }],
          childCount: 3,
          siblingCount: 2
        }
      }
    });

    expect(capture.profiles?.component).toMatchObject({
      kind: "card",
      intent: "layout",
      structure: {
        container: "section",
        parentDisplay: "grid",
        childCount: 3,
        siblingCount: 2
      },
      appearance: {
        visualTags: expect.arrayContaining(["grid", "filled", "rounded", "shadow", "bordered"])
      },
      templateHints: expect.arrayContaining(["prefer local Card primitive when available"])
    });
  });
});

function captureFixture(args: {
  element: Partial<CapturedUiReference["element"]> & Pick<CapturedUiReference["element"], "tagName" | "selector" | "selectorConfidence">;
  hitElement?: Partial<NonNullable<CapturedUiReference["hitElement"]>> & Pick<NonNullable<CapturedUiReference["hitElement"]>, "tagName" | "selector" | "selectorConfidence">;
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
    hitElement: args.hitElement ? {
      classNames: [],
      bounds: {
        x: 12,
        y: 22,
        width: 16,
        height: 16
      },
      ...args.hitElement
    } : undefined
  };
}
