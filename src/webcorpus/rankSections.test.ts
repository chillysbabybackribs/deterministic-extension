import { describe, expect, it } from "vitest";
import {
  buildSectionIndex,
  formatSectionsAsStructuredSummary,
  rankSections,
  rankSectionsAcrossSites
} from "./rankSections";
import type { ContentSection, PageEntry, WebCorpus } from "./webCorpusTypes";

function section(id: string, title: string, text: string, sourceUrls = [id]): ContentSection {
  return {
    id,
    ordinal: Number(id.replace(/\D/g, "")) || 0,
    contentKey: id,
    title,
    text,
    sourceUrls,
    capturedAt: "2026-05-29T00:00:00.000Z",
    searchText: `${title} ${text}`
  };
}

function page(pageId: string, sections: ContentSection[]): PageEntry {
  return {
    pageId,
    title: "T",
    lastUrl: pageId,
    capturedAt: "2026-05-29T00:00:00.000Z",
    visitCount: 1,
    components: [],
    contentSections: sections,
    rawElementCount: 0,
    dedupedCount: 0,
    warnings: []
  };
}

function corpus(pages: PageEntry[], siteId = "https://docs.test"): WebCorpus {
  const all = pages.flatMap((p) => p.contentSections);
  return {
    siteId,
    siteName: siteId.replace(/^https?:\/\//, ""),
    createdAt: "t",
    updatedAt: "t",
    pages: Object.fromEntries(pages.map((p) => [p.pageId, p])),
    pageCount: pages.length,
    componentCount: 0,
    sectionCount: all.length,
    index: { n: 0, df: {}, tf: {} },
    contentIndex: buildSectionIndex(all),
    warnings: []
  };
}

describe("rankSections", () => {
  it("ranks the section that matches the query terms highest", () => {
    const c = corpus([
      page("https://docs.test/a", [
        section("s1", "Pricing", "Plans start at ten dollars per month with annual discounts."),
        section("s2", "Installation", "Run npm install to add the package to your project.")
      ])
    ]);
    const ranked = rankSections(c, "how much does it cost pricing dollars");
    expect(ranked[0]?.section.id).toBe("s1");
  });

  it("returns nothing when no terms match", () => {
    const c = corpus([page("https://docs.test/a", [section("s1", "Pricing", "ten dollars")])]);
    expect(rankSections(c, "kangaroo helicopter")).toEqual([]);
  });

  it("marks current-site hits and emits them before other-site hits", () => {
    const current = corpus(
      [page("https://docs.test/a", [section("s1", "Setup", "configure the api token here")])],
      "https://docs.test"
    );
    const other = corpus(
      [page("https://other.test/x", [section("s9", "Setup", "configure the api token elsewhere")])],
      "https://other.test"
    );
    const ranked = rankSectionsAcrossSites([other, current], "configure api token", "https://docs.test");
    expect(ranked[0]?.currentSite).toBe(true);
    expect(ranked[0]?.section.id).toBe("s1");
    expect(ranked.some((h) => !h.currentSite && h.section.id === "s9")).toBe(true);
  });
});

describe("formatSectionsAsStructuredSummary", () => {
  it("renders verbatim text and source urls, empty when no hits", () => {
    expect(formatSectionsAsStructuredSummary([])).toBe("");
    const c = corpus([
      page("https://docs.test/a", [section("s1", "Pricing", "Ten dollars per month.", ["https://docs.test/pricing"])])
    ]);
    const out = formatSectionsAsStructuredSummary(rankSections(c, "pricing dollars"));
    expect(out).toContain("### Pricing");
    expect(out).toContain("https://docs.test/pricing");
    expect(out).toContain("Ten dollars per month.");
  });

  it("bounds total size to maxChars but always keeps at least one block", () => {
    const c = corpus([
      page("https://docs.test/a", [
        section("s1", "One", "alpha ".repeat(50)),
        section("s2", "Two", "alpha ".repeat(50))
      ])
    ]);
    const out = formatSectionsAsStructuredSummary(rankSections(c, "alpha"), 50);
    // Only one block fits under the tiny cap, but we never return empty on hits.
    expect(out).toContain("###");
    expect(out.match(/###/g)?.length).toBe(1);
  });
});
