import { describe, expect, it } from "vitest";
import { buildCorpus, normalizeLabel, renderCandidate, searchCorpus } from "./elementCorpus";
import type { ActionableElement } from "./elementOverlay";

function el(index: number, over: Partial<ActionableElement> = {}): ActionableElement {
  return {
    index,
    tagName: over.tagName ?? "button",
    type: over.type,
    role: over.role ?? "button",
    roleSource: "implicit",
    accessibleName: over.accessibleName,
    accessibleNameSource: over.accessibleName ? "text" : "none",
    bounds: { x: 0, y: 0, width: 10, height: 10, pageX: 0, pageY: 0 },
    inViewport: true,
    isVisible: true,
    isEnabled: true,
    matchedBy: over.matchedBy ?? "button",
    attributes: { hasHref: false, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
    link: over.link,
    ...over
  };
}

const corpusOf = (elements: ActionableElement[]) => buildCorpus({ elements });

describe("normalizeLabel", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeLabel("  Sign In! ")).toBe("sign in");
    expect(normalizeLabel("Save & Continue")).toBe("save continue");
    expect(normalizeLabel(undefined)).toBe("");
  });
});

describe("searchCorpus — exact match fires deterministically", () => {
  it("returns EXACT for a unique normalized-name equality", () => {
    const corpus = corpusOf([
      el(1, { accessibleName: "Sign in with Google" }),
      el(2, { accessibleName: "Sign in" }),
      el(3, { accessibleName: "Create account" })
    ]);
    const r = searchCorpus("sign in", corpus);
    expect(r.kind).toBe("exact");
    expect(r.kind === "exact" && r.winner.index).toBe(2);
  });

  it("normalizes punctuation/case on BOTH sides for the exact match", () => {
    const corpus = corpusOf([el(1, { accessibleName: "Sign In!" })]);
    const r = searchCorpus("  sign in ", corpus);
    expect(r.kind).toBe("exact");
  });

  it("does NOT fire exact when the same name appears on TWO elements (ambiguous) — shortlists instead", () => {
    const corpus = corpusOf([
      el(1, { accessibleName: "Edit" }),
      el(2, { accessibleName: "Edit" })
    ]);
    const r = searchCorpus("edit", corpus);
    expect(r.kind).toBe("shortlist");
    expect(r.kind === "shortlist" && r.candidates.map((c) => c.index)).toEqual([1, 2]);
  });
});

describe("searchCorpus — shortlist when no unique exact match", () => {
  it("shortlists name-containing candidates, exact-multiples first, capped", () => {
    const corpus = corpusOf([
      el(1, { accessibleName: "Home" }),
      el(2, { accessibleName: "Save draft" }),
      el(3, { accessibleName: "Save" }),
      el(4, { accessibleName: "Save and continue" })
    ]);
    // "save" is NOT unique-exact (only #3 equals it exactly → actually exact).
    // Use a partial target that is not an exact name to force a shortlist:
    const r = searchCorpus("save changes", corpus);
    expect(r.kind).toBe("shortlist");
    // Candidates must include the save-family (contain "save"), not "Home".
    const idxs = r.kind === "shortlist" ? r.candidates.map((c) => c.index) : [];
    expect(idxs).toContain(2);
    expect(idxs).toContain(3);
    expect(idxs).toContain(4);
  });

  it("respects the shortlist limit", () => {
    const corpus = corpusOf(Array.from({ length: 12 }, (_, i) => el(i + 1, { accessibleName: `Item ${i + 1}` })));
    const r = searchCorpus("item", corpus, { shortlistLimit: 5 });
    expect(r.kind).toBe("shortlist");
    expect(r.kind === "shortlist" && r.candidates.length).toBe(5);
  });

  it("falls back to the whole list (capped) when nothing contains the target", () => {
    const corpus = corpusOf([el(1, { accessibleName: "Home" }), el(2, { accessibleName: "About" })]);
    const r = searchCorpus("checkout", corpus);
    // No name contains "checkout" → still hands the model the page's elements.
    expect(r.kind).toBe("shortlist");
    expect(r.kind === "shortlist" && r.candidates.length).toBe(2);
  });

  it("can restrict ambiguous fallback candidates to actual links", () => {
    const corpus = corpusOf([
      el(1, { accessibleName: "More actions", role: "button", tagName: "button" }),
      el(2, {
        accessibleName: "Web search",
        role: "link",
        tagName: "a",
        attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
        link: { href: "https://example.com/docs/web", path: "/docs/web", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
      }),
      el(3, {
        accessibleName: "Answers",
        role: "link",
        tagName: "a",
        attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
        link: { href: "https://example.com/docs/answers", path: "/docs/answers", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
      })
    ]);
    const r = searchCorpus("navigation", corpus, { requireLink: true });
    expect(r.kind).toBe("shortlist");
    expect(r.kind === "shortlist" && r.candidates.map((candidate) => candidate.index)).toEqual([2, 3]);
  });

  it("can prefer non-current link destinations for generic navigation prompts", () => {
    const corpus = corpusOf([
      el(1, {
        accessibleName: "Documentation",
        role: "link",
        tagName: "a",
        attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
        link: { href: "https://example.com/docs", path: "/docs", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
      }),
      el(2, {
        accessibleName: "Web search",
        role: "link",
        tagName: "a",
        attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
        link: { href: "https://example.com/docs/web", path: "/docs/web", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
      })
    ]);
    const r = searchCorpus("navigation", corpus, {
      requireLink: true,
      currentUrl: "https://example.com/docs",
      preferNonCurrentUrl: true
    });
    expect(r.kind).toBe("shortlist");
    expect(r.kind === "shortlist" && r.candidates.map((candidate) => candidate.index)).toEqual([2]);
  });

  it("marks self-links when rendering candidates with current page context", () => {
    const candidate = el(1, {
      accessibleName: "Documentation",
      role: "link",
      tagName: "a",
      attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
      link: { href: "https://example.com/docs#top", path: "/docs", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
    });
    expect(renderCandidate(candidate, { currentUrl: "https://example.com/docs" })).toContain("(current page)");
  });

  it("uses the link restriction before deciding a unique exact match", () => {
    const corpus = corpusOf([
      el(1, { accessibleName: "Pricing", role: "button", tagName: "button" }),
      el(2, {
        accessibleName: "Pricing",
        role: "link",
        tagName: "a",
        attributes: { hasHref: true, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
        link: { href: "https://example.com/pricing", path: "/pricing", origin: "https://example.com", rel: "same-origin", target: undefined, isDownload: false, kind: "navigation" }
      })
    ]);
    const r = searchCorpus("pricing", corpus, { requireLink: true });
    expect(r.kind).toBe("exact");
    expect(r.kind === "exact" && r.winner.index).toBe(2);
  });

  it("returns NONE for an empty corpus or empty target", () => {
    expect(searchCorpus("sign in", corpusOf([])).kind).toBe("none");
    expect(searchCorpus("", corpusOf([el(1, { accessibleName: "Home" })])).kind).toBe("none");
  });
});
