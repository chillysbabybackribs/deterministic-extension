import { describe, expect, it } from "vitest";
import { buildComponentIndex, rankComponents } from "./rankComponents";
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

function corpus(pages: PageEntry[]): WebCorpus {
  const all = pages.flatMap((p) => p.components);
  return {
    siteId: "https://shop.test",
    siteName: "shop.test",
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
