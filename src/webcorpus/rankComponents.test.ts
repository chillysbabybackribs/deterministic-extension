import { describe, expect, it } from "vitest";
import { buildComponentIndex, formatRankedComponentsForPlanner, rankAcrossSites, rankComponents } from "./rankComponents";
import type { ComponentEntry, PageEntry, WebCorpus } from "./webCorpusTypes";

function component(id: string, name: string, searchText = name): ComponentEntry {
  return {
    id,
    ordinal: Number(id.replace(/\D/g, "")) || 0,
    behaviorKey: id,
    instanceCount: 1,
    kind: "button",
    region: "unknown",
    name,
    searchText
  };
}

function page(pageId: string, components: ComponentEntry[]): PageEntry {
  return {
    pageId,
    title: "T",
    lastUrl: pageId,
    capturedAt: "2026-05-29T00:00:00.000Z",
    visitCount: 1,
    components,
    rawElementCount: components.length,
    dedupedCount: 0,
    warnings: []
  };
}

function corpus(pages: PageEntry[], siteId = "https://shop.test"): WebCorpus {
  const all = pages.flatMap((p) => p.components);
  return {
    siteId,
    siteName: siteId.replace(/^https?:\/\//, ""),
    createdAt: "t",
    updatedAt: "t",
    pages: Object.fromEntries(pages.map((p) => [p.pageId, p])),
    pageCount: pages.length,
    componentCount: all.length,
    index: buildComponentIndex(all),
    warnings: []
  };
}

describe("rankComponents", () => {
  it("ranks by query overlap and returns the matching component with its page", () => {
    const c = corpus([
      page("https://shop.test/", [
        component("c1", "add to cart", "add to cart /cart/:id/add navigation"),
        component("c2", "search", "search /search navigation"),
        component("c3", "sign in", "sign in /login navigation")
      ])
    ]);
    const ranked = rankComponents(c, "add item to my cart");
    expect(ranked[0].component.id).toBe("c1");
    expect(ranked[0].pageId).toBe("https://shop.test/");
    expect(ranked[0].matchedTerms).toEqual(expect.arrayContaining(["add", "cart"]));
  });

  it("searches across pages of the same site", () => {
    const c = corpus([
      page("https://shop.test/a", [component("a1", "checkout", "checkout /checkout navigation")]),
      page("https://shop.test/b", [component("b1", "wishlist", "wishlist /wishlist navigation")])
    ]);
    const ranked = rankComponents(c, "checkout");
    expect(ranked).toHaveLength(1);
    expect(ranked[0].pageId).toBe("https://shop.test/a");
  });

  it("returns nothing for a non-matching query", () => {
    const c = corpus([page("https://shop.test/", [component("c1", "add to cart", "add to cart")])]);
    expect(rankComponents(c, "logout")).toEqual([]);
  });

  it("respects the limit", () => {
    const comps = Array.from({ length: 10 }, (_, i) => component(`c${i}`, `cart option ${i}`, `cart option ${i}`));
    const ranked = rankComponents(corpus([page("https://shop.test/", comps)]), "cart", 3);
    expect(ranked).toHaveLength(3);
  });

  it("rarer terms outweigh common ones (idf)", () => {
    // "cart" appears in many components; "wishlist" in one. A query with both
    // should rank the wishlist-bearing component highest.
    const comps = [
      ...Array.from({ length: 8 }, (_, i) => component(`cart${i}`, "cart", "cart")),
      component("w1", "cart wishlist", "cart wishlist")
    ];
    const ranked = rankComponents(corpus([page("https://shop.test/", comps)]), "cart wishlist");
    expect(ranked[0].component.id).toBe("w1");
  });
});

describe("recall scenario (koenvangilst.nl)", () => {
  // Mirrors the live run: two pages mapped for the site, the correct target
  // ("mistral ai now summit" → /lab/mistral-ai-now-summit) living on a DIFFERENT
  // page than the one a prompt might land on. Recall should surface it.
  it("surfaces the correct mapped summit link from across pages", () => {
    const c = corpus([
      page("https://koenvangilst.nl/notes-from-the-mistral-ai-now-summit-in-paris", [
        { ...component("n1", "home", "home /"), kind: "link", label: "Home", destination: { pattern: "/", kind: "navigation", examples: [] } },
        { ...component("n2", "notes", "notes /notes"), kind: "link", label: "Notes", destination: { pattern: "/notes", kind: "navigation", examples: [] } }
      ]),
      page("https://koenvangilst.nl/lab/mistral-ai-now-summit", [
        { ...component("l1", "mistral ai now summit", "mistral ai now summit lab /lab/mistral-ai-now-summit"), kind: "link", label: "Mistral AI Now Summit", destination: { pattern: "/lab/mistral-ai-now-summit", kind: "navigation", examples: [] } }
      ])
    ]);
    const ranked = rankComponents(c, "open the mistral ai now summit note");
    expect(ranked[0].component.label).toBe("Mistral AI Now Summit");
    expect(ranked[0].pageId).toBe("https://koenvangilst.nl/lab/mistral-ai-now-summit");
    expect(ranked[0].component.destination?.pattern).toBe("/lab/mistral-ai-now-summit");
  });
});

describe("formatRankedComponentsForPlanner", () => {
  it("renders behavior, destination, instance count and page", () => {
    const c = corpus([
      page("https://shop.test/cart", [
        { ...component("c1", "add to cart", "add to cart"), instanceCount: 12, label: "Add to cart", destination: { pattern: "/cart/:id/add", kind: "navigation", examples: [] } }
      ])
    ]);
    const out = formatRankedComponentsForPlanner(rankComponents(c, "add to cart"));
    expect(out).toContain("recalled from your accumulated site map");
    expect(out).toContain('"Add to cart" ×12 → /cart/:id/add (on https://shop.test/cart)');
  });

  it("returns empty string for no hits so the section can be dropped", () => {
    expect(formatRankedComponentsForPlanner([])).toBe("");
  });

  it("tags cross-site hits as [other site]", () => {
    const a = corpus([page("https://a.test/", [component("c1", "checkout", "checkout /checkout")])], "https://a.test");
    const out = formatRankedComponentsForPlanner(rankAcrossSites([a], "checkout", "https://b.test"));
    expect(out).toContain("[other site]");
  });
});

describe("rankAcrossSites", () => {
  const shop = corpus([page("https://shop.test/", [component("s1", "checkout", "checkout /checkout")])], "https://shop.test");
  const blog = corpus([page("https://blog.test/post", [component("b1", "mistral summit", "mistral summit /lab/mistral-summit")])], "https://blog.test");

  it("puts current-site hits first, other sites after", () => {
    // Both corpora contain a "summit"-ish term? No — query matches both pools.
    const shopWithSummit = corpus(
      [page("https://shop.test/", [component("s2", "summit deals", "summit deals /deals")])],
      "https://shop.test"
    );
    const ranked = rankAcrossSites([shopWithSummit, blog], "summit", "https://shop.test");
    expect(ranked[0].currentSite).toBe(true);
    expect(ranked[0].siteId).toBe("https://shop.test");
    expect(ranked.some((h) => h.siteId === "https://blog.test" && !h.currentSite)).toBe(true);
  });

  it("surfaces other-site hits when the current site has none (corpus is first-class)", () => {
    // On shop.test, but the only match is on blog.test.
    const ranked = rankAcrossSites([shop, blog], "mistral summit", "https://shop.test");
    expect(ranked).toHaveLength(1);
    expect(ranked[0].siteId).toBe("https://blog.test");
    expect(ranked[0].currentSite).toBe(false);
  });

  it("returns nothing when no site matches (falls through to general pipeline)", () => {
    expect(rankAcrossSites([shop, blog], "logout", "https://shop.test")).toEqual([]);
  });

  it("works when the current site isn't mapped at all", () => {
    const ranked = rankAcrossSites([shop, blog], "checkout", "https://unmapped.test");
    expect(ranked[0].siteId).toBe("https://shop.test");
    expect(ranked[0].currentSite).toBe(false);
  });
});
