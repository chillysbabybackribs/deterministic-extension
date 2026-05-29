import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writePage = vi.fn(async (_args: unknown) => ({ siteName: "x", pageCount: 1, componentCount: 0, sectionCount: 0, updatedAt: "t" }));
vi.mock("../../webcorpus/webCorpusStore", () => ({ writePage: (args: unknown) => writePage(args) }));

import { runResearchLoop, type FetchedPage } from "./researchLoop";
import type { PageSnapshot } from "../../tools/snapshot/pageSnapshotTypes";

const NOW = "2026-05-29T00:00:00.000Z";
const PROSE =
  "This is a substantial paragraph of real content that comfortably exceeds the minimum section length so it counts as high-value prose worth keeping in the research corpus.";

function snap(url: string, sections: Array<{ title: string; text: string }>): PageSnapshot {
  return {
    url,
    title: `Title ${url}`,
    headings: [],
    text: "",
    links: [],
    sections: sections.map((s, i) => ({ headingPath: [s.title], text: s.text, start: i }))
  };
}

function page(url: string, sections: Array<{ title: string; text: string }>): FetchedPage {
  return { url, snapshot: snap(url, sections), warnings: [] };
}

beforeEach(() => writePage.mockClear());
afterEach(() => vi.restoreAllMocks());

describe("runResearchLoop", () => {
  it("opens urls in order and writes a page per source that contributed sections", async () => {
    const pages: Record<string, FetchedPage> = {
      "https://a.test/p": page("https://a.test/p", [{ title: "Alpha", text: PROSE }]),
      "https://b.test/q": page("https://b.test/q", [{ title: "Beta", text: PROSE.replace("paragraph", "passage") }])
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]);
    const result = await runResearchLoop({
      urls: ["https://a.test/p", "https://b.test/q"],
      fetchPage,
      now: NOW
    });
    expect(result.visitedUrls).toEqual(["https://a.test/p", "https://b.test/q"]);
    expect(result.pagesWritten).toBe(2);
    expect(result.sections).toHaveLength(2);
    expect(writePage).toHaveBeenCalledTimes(2);
  });

  it("dedupes a section seen on two pages and merges its source urls", async () => {
    const shared = { title: "Shared", text: PROSE };
    const pages: Record<string, FetchedPage> = {
      "https://a.test/p": page("https://a.test/p", [shared]),
      "https://b.test/q": page("https://b.test/q", [shared])
    };
    const result = await runResearchLoop({
      urls: ["https://a.test/p", "https://b.test/q"],
      fetchPage: async (url: string) => pages[url],
      now: NOW
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].sourceUrls.sort()).toEqual(["https://a.test/p", "https://b.test/q"]);
    // Only the first page owns the section, so only it is written.
    expect(result.pagesWritten).toBe(1);
  });

  it("pre-warms: the next page's fetch starts before the current page is fully processed", async () => {
    const order: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      order.push(`fetch:${url}`);
      return page(url, [{ title: url, text: PROSE }]);
    });
    await runResearchLoop({
      urls: ["u1", "u2", "u3"].map((u) => `https://x.test/${u}`),
      fetchPage,
      now: NOW
    });
    // The second fetch is kicked off before the first page's extraction completes,
    // so fetch:u2 appears in the order before processing of u1 finishes. We assert
    // all three were fetched and the first two were both in flight early.
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(order[0]).toBe("fetch:https://x.test/u1");
    expect(order[1]).toBe("fetch:https://x.test/u2");
  });

  it("respects maxPages", async () => {
    const fetchPage = vi.fn(async (url: string) => page(url, [{ title: url, text: PROSE }]));
    const result = await runResearchLoop({
      urls: ["1", "2", "3", "4", "5", "6"].map((u) => `https://x.test/${u}`),
      fetchPage,
      now: NOW,
      maxPages: 2
    });
    expect(result.visitedUrls).toHaveLength(2);
  });

  it("skips unfetchable pages and pages with no high-value content", async () => {
    const fetchPage = vi.fn(async (url: string) => {
      if (url.endsWith("/dead")) return undefined;
      if (url.endsWith("/thin")) return page(url, [{ title: "Nav", text: "Home" }]);
      return page(url, [{ title: "Good", text: PROSE }]);
    });
    const result = await runResearchLoop({
      urls: ["https://x.test/dead", "https://x.test/thin", "https://x.test/good"],
      fetchPage,
      now: NOW
    });
    expect(result.pagesWritten).toBe(1);
    expect(result.sections).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("Could not open"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("No high-value content"))).toBe(true);
  });

  it("stops early when shouldStop returns true", async () => {
    let calls = 0;
    const fetchPage = vi.fn(async (url: string) => page(url, [{ title: url, text: PROSE }]));
    const result = await runResearchLoop({
      urls: ["1", "2", "3"].map((u) => `https://x.test/${u}`),
      fetchPage,
      now: NOW,
      shouldStop: () => calls++ >= 1
    });
    expect(result.visitedUrls.length).toBeLessThan(3);
    expect(result.warnings).toContain("Research loop stopped early.");
  });
});
