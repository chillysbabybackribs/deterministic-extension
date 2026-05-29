import { describe, expect, it } from "vitest";
import { behaviorKeyFor, destinationPattern, ingestPage, toPageId, toSiteId } from "./ingestPage";
import type { ActionableElement, OverlayCaptureResult } from "../tools/elementOverlay";

function link(path: string): ActionableElement["link"] {
  return { href: `https://shop.test${path}`, path, origin: "https://shop.test", rel: "same-origin", isDownload: false, kind: "navigation" };
}

function el(index: number, name: string, extra: Partial<ActionableElement> = {}): ActionableElement {
  return {
    index,
    tagName: "BUTTON",
    role: "button",
    roleSource: "implicit",
    accessibleName: name,
    accessibleNameSource: "text",
    bounds: { x: 0, y: 0, width: 10, height: 10, pageX: 0, pageY: 0 },
    inViewport: true,
    isVisible: true,
    isEnabled: true,
    matchedBy: "button",
    attributes: { hasHref: false, hasAriaLabel: false, hasAriaLabelledby: false, hasAnyAria: false },
    ...extra
  };
}

function capture(url: string, elements: ActionableElement[]): OverlayCaptureResult {
  return {
    url,
    title: "T",
    viewport: { width: 1, height: 1, devicePixelRatio: 1, scrollX: 0, scrollY: 0, documentWidth: 1, documentHeight: 1 },
    elements,
    candidateCount: elements.length,
    droppedByDedup: 0,
    warnings: []
  };
}

describe("key normalization", () => {
  it("siteId is scheme + lowercased host", () => {
    expect(toSiteId("https://WWW.Amazon.com/gp/cart?x=1")).toEqual({
      siteId: "https://www.amazon.com",
      siteName: "www.amazon.com"
    });
  });

  it("pageId strips query and hash and trailing slash", () => {
    expect(toPageId("https://www.amazon.com/gp/cart/?x=1#frag")).toBe("https://www.amazon.com/gp/cart");
    expect(toPageId("https://www.amazon.com/")).toBe("https://www.amazon.com/");
  });

  it("rejects non-http(s) urls", () => {
    expect(toSiteId("chrome://extensions")).toBeUndefined();
    expect(toPageId("about:blank")).toBeUndefined();
  });
});

describe("destinationPattern", () => {
  it("templates numeric and id-like segments to :id", () => {
    expect(destinationPattern("/product/123/add")).toBe("/product/:id/add");
    expect(destinationPattern("/u/9f8e7d6c5b4a3210")).toBe("/u/:id");
    expect(destinationPattern("/item/widget-4582")).toBe("/item/:id");
  });
  it("leaves plain segments untouched", () => {
    expect(destinationPattern("/gp/cart")).toBe("/gp/cart");
    expect(destinationPattern("/")).toBe("/");
  });
  it("strips query and hash", () => {
    expect(destinationPattern("/search?q=x#top")).toBe("/search");
  });
});

describe("behaviorKeyFor", () => {
  it("is stable across (kind, name, pattern)", () => {
    expect(behaviorKeyFor("button", "add to cart", "/cart/:id/add")).toBe("button|add to cart|/cart/:id/add");
  });
});

describe("ingestPage (behavioral dedup)", () => {
  it("collapses identical-destination links that differ only by id", () => {
    const result = ingestPage(
      capture("https://shop.test/items", [
        el(1, "Add to cart", { tagName: "A", role: "link", link: link("/cart/123/add") }),
        el(2, "Add to cart", { tagName: "A", role: "link", link: link("/cart/456/add") }),
        el(3, "Add to cart", { tagName: "A", role: "link", link: link("/cart/789/add") })
      ]),
      "2026-05-29T00:00:00.000Z"
    );
    expect(result!.page.components).toHaveLength(1);
    const c = result!.page.components[0];
    expect(c.instanceCount).toBe(3);
    expect(c.ordinal).toBe(1); // lowest / first occurrence
    expect(c.behaviorKey).toBe("link|add to cart|/cart/:id/add");
    expect(c.destination?.pattern).toBe("/cart/:id/add");
    expect(c.destination?.examples).toHaveLength(3); // bounded
    expect(result!.page.dedupedCount).toBe(2);
    expect(result!.page.rawElementCount).toBe(3);
  });

  it("keeps behaviorally-distinct components separate", () => {
    const result = ingestPage(
      capture("https://shop.test/", [
        el(1, "Add to cart", { tagName: "A", role: "link", link: link("/cart/1/add") }),
        el(2, "Buy now", { tagName: "A", role: "link", link: link("/buy/1") }),
        el(3, "Add to cart") // same name, but a button with no destination → different key
      ]),
      "2026-05-29T00:00:00.000Z"
    );
    expect(result!.page.components).toHaveLength(3);
    expect(result!.page.dedupedCount).toBe(0);
  });

  it("bounds destination examples to 3 even with many instances", () => {
    const els = Array.from({ length: 50 }, (_, i) =>
      el(i + 1, "Add to cart", { tagName: "A", role: "link", link: link(`/cart/${i}/add`) })
    );
    const result = ingestPage(capture("https://shop.test/grid", els), "2026-05-29T00:00:00.000Z");
    expect(result!.page.components).toHaveLength(1);
    expect(result!.page.components[0].instanceCount).toBe(50);
    expect(result!.page.components[0].destination?.examples.length).toBeLessThanOrEqual(3);
    expect(result!.page.dedupedCount).toBe(49);
  });

  it("carries link destination into the component", () => {
    const linked = el(1, "Cart", { tagName: "A", role: "link", link: link("/cart") });
    const result = ingestPage(capture("https://shop.test/", [linked]), "2026-05-29T00:00:00.000Z");
    expect(result!.page.components[0].destination).toMatchObject({ pattern: "/cart", kind: "navigation" });
    expect(result!.page.components[0].searchText).toContain("cart");
  });

  it("returns undefined for unkeyable pages", () => {
    expect(ingestPage(capture("about:blank", [el(1, "x")]), "2026-05-29T00:00:00.000Z")).toBeUndefined();
  });
});
