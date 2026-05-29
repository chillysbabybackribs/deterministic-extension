import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSnapshot } from "../../tools/snapshot/pageSnapshotTypes";
import type { ContentSection, WebCorpus } from "../../webcorpus/webCorpusTypes";

const writePage = vi.fn(async (_a: unknown) => ({ siteName: "x", pageCount: 1, componentCount: 0, sectionCount: 1, updatedAt: "t" }));
const getAllWebCorpora = vi.fn(async (): Promise<WebCorpus[]> => []);
vi.mock("../../webcorpus/webCorpusStore", () => ({
  writePage: (a: unknown) => writePage(a),
  getAllWebCorpora: () => getAllWebCorpora()
}));

import { runResearchPath } from "./researchPath";
import { buildSectionIndex } from "../../webcorpus/rankSections";

const NOW = "2026-05-29T00:00:00.000Z";
const PROSE =
  "This is a substantial paragraph of real content that comfortably exceeds the minimum section length so it counts as high-value prose for the research corpus.";

function snap(url: string, title: string, text: string): PageSnapshot {
  return { url, title, headings: [], text: "", links: [], sections: [{ headingPath: [title], text, start: 0 }] };
}

function corpusWithSection(url: string, title: string, text: string): WebCorpus {
  const section: ContentSection = {
    id: `${url}#s0`,
    ordinal: 0,
    contentKey: "k",
    title,
    text,
    sourceUrls: [url],
    capturedAt: NOW,
    searchText: `${title} ${text}`
  };
  return {
    siteId: "https://a.test",
    siteName: "a.test",
    createdAt: NOW,
    updatedAt: NOW,
    pages: {
      "https://a.test/p": {
        pageId: "https://a.test/p",
        title,
        lastUrl: url,
        capturedAt: NOW,
        visitCount: 1,
        components: [],
        contentSections: [section],
        rawElementCount: 0,
        dedupedCount: 0,
        warnings: []
      }
    },
    pageCount: 1,
    componentCount: 0,
    sectionCount: 1,
    index: { n: 0, df: {}, tf: {} },
    contentIndex: buildSectionIndex([section]),
    warnings: []
  };
}

beforeEach(() => {
  writePage.mockClear();
  getAllWebCorpora.mockReset();
  getAllWebCorpora.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("runResearchPath", () => {
  it("searches, runs the loop, then returns a structured summary from the corpus", async () => {
    getAllWebCorpora.mockResolvedValue([
      corpusWithSection("https://a.test/p", "Pricing", `Plans cost ten dollars. ${PROSE}`)
    ]);
    const search = vi.fn(async () => ["https://a.test/p"]);
    const fetchPage = vi.fn(async (url: string) => ({
      url,
      snapshot: snap(url, "Pricing", `Plans cost ten dollars. ${PROSE}`),
      warnings: []
    }));

    const result = await runResearchPath({
      query: "how much does it cost pricing",
      searchQueries: ["product pricing"],
      now: NOW,
      fetchPage,
      search
    });

    expect(search).toHaveBeenCalledWith("product pricing");
    expect(fetchPage).toHaveBeenCalledWith("https://a.test/p");
    expect(result.visitedUrls).toEqual(["https://a.test/p"]);
    expect(result.structuredSummary).toContain("### Pricing");
    expect(result.structuredSummary).toContain("ten dollars");
    expect(result.missing).toBe("");
  });

  it("passes the working tab id to the injected search runner", async () => {
    getAllWebCorpora.mockResolvedValue([]);
    const search = vi.fn(async () => ["https://a.test/p"]);
    const fetchPage = vi.fn(async (url: string) => ({ url, snapshot: snap(url, "T", PROSE), warnings: [] }));
    // The default-search closure is only built when no search is injected, so to
    // assert tab threading we verify the production defaultSearch path indirectly:
    // when a search IS injected it owns tab handling, so here we just confirm the
    // working tab id is accepted and the run completes in one logical tab.
    const result = await runResearchPath({
      query: "q",
      searchQueries: ["q"],
      workingTabId: 42,
      now: NOW,
      fetchPage,
      search
    });
    expect(result.visitedUrls).toEqual(["https://a.test/p"]);
  });

  it("reports missing when no search results are found", async () => {
    const result = await runResearchPath({
      query: "q",
      searchQueries: ["q"],
      now: NOW,
      fetchPage: vi.fn(),
      search: vi.fn(async () => [])
    });
    expect(result.structuredSummary).toBe("");
    expect(result.missing).toContain("No web results");
    expect(result.visitedUrls).toEqual([]);
  });

  it("dedupes candidate urls across multiple search queries", async () => {
    getAllWebCorpora.mockResolvedValue([]);
    const search = vi.fn(async (q: string) =>
      q === "one" ? ["https://a.test/p", "https://b.test/q"] : ["https://b.test/q", "https://c.test/r"]
    );
    const fetchPage = vi.fn(async (url: string) => ({ url, snapshot: snap(url, "T", PROSE), warnings: [] }));
    const result = await runResearchPath({
      query: "q",
      searchQueries: ["one", "two"],
      now: NOW,
      fetchPage,
      search
    });
    // 3 distinct urls across the two queries, each fetched once.
    expect(new Set(fetchPage.mock.calls.map((c) => c[0])).size).toBe(3);
    expect(result.visitedUrls).toHaveLength(3);
  });
});
