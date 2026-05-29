import { describe, expect, it } from "vitest";
import { pageReadinessSignature, type PageReadinessSample } from "./pageReadiness";

function sample(over: Partial<PageReadinessSample> = {}): PageReadinessSample {
  return {
    href: "https://example.com/account",
    title: "Account",
    readyState: "complete",
    textLength: 24,
    textHash: 123,
    elementCount: 100,
    resourceCount: 20,
    busyCount: 0,
    ...over
  };
}

describe("pageReadinessSignature", () => {
  it("changes when visible text content changes even if its length does not", () => {
    const stale = pageReadinessSignature(sample({ textLength: 24, textHash: 111 }));
    const fresh = pageReadinessSignature(sample({ textLength: 24, textHash: 222 }));

    expect(fresh).not.toBe(stale);
  });

  it("changes when late resources or DOM updates arrive", () => {
    const before = pageReadinessSignature(sample({ resourceCount: 20, elementCount: 100 }));
    const after = pageReadinessSignature(sample({ resourceCount: 21, elementCount: 101 }));

    expect(after).not.toBe(before);
  });
});
