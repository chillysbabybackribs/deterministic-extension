import { describe, expect, it } from "vitest";
import { extractContentSections } from "./extractContentSections";
import type { PageSnapshot } from "../tools/snapshot/pageSnapshotTypes";

const NOW = "2026-05-29T00:00:00.000Z";

function snapshot(overrides: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://docs.test/guide",
    title: "Docs Guide",
    headings: [],
    text: "",
    links: [],
    ...overrides
  };
}

const PROSE = "This is a substantial paragraph of real content that comfortably exceeds the minimum section length so that it is treated as high-value prose worth keeping in the research corpus for later retrieval.";

describe("extractContentSections", () => {
  it("turns structured sections into labelled verbatim ContentSections", () => {
    const sections = extractContentSections(
      snapshot({
        sections: [
          { headingPath: ["Overview"], text: PROSE, start: 0 },
          { headingPath: ["Pricing"], text: `Plans start at $10/month. ${PROSE}`, start: 1 }
        ]
      }),
      NOW
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe("Overview");
    expect(sections[0].text).toContain("substantial paragraph");
    expect(sections[0].sourceUrls).toEqual(["https://docs.test/guide"]);
    expect(sections[0].capturedAt).toBe(NOW);
    expect(sections.find((s) => s.title === "Pricing")?.text).toContain("$10/month");
  });

  it("drops too-short blocks and recognizable boilerplate", () => {
    const sections = extractContentSections(
      snapshot({
        sections: [
          { headingPath: ["Nav"], text: "Home", start: 0 },
          { headingPath: [""], text: "We use cookies to improve your experience on this website and analytics.", start: 1 },
          { headingPath: ["Real"], text: PROSE, start: 2 }
        ]
      }),
      NOW
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Real");
  });

  it("rejects link-dump blocks (mostly short lines)", () => {
    const linkDump = ["Home", "About", "Pricing", "Docs", "Blog", "Careers", "Contact", "Login"].join("\n");
    const sections = extractContentSections(
      snapshot({ sections: [{ headingPath: ["Menu"], text: linkDump, start: 0 }] }),
      NOW
    );
    expect(sections).toHaveLength(0);
  });

  it("dedupes identical sections within a page, merging source urls", () => {
    const sections = extractContentSections(
      snapshot({
        sections: [
          { headingPath: ["A"], text: PROSE, start: 0 },
          { headingPath: ["A"], text: PROSE, start: 1 }
        ]
      }),
      NOW
    );
    expect(sections).toHaveLength(1);
    // Same url seen twice collapses; sourceUrls stays a single entry.
    expect(sections[0].sourceUrls).toEqual(["https://docs.test/guide"]);
  });

  it("derives a title from the first sentence when no heading is present", () => {
    const sections = extractContentSections(
      snapshot({ sections: [{ headingPath: [], text: `Getting started is easy. ${PROSE}`, start: 0 }] }),
      NOW
    );
    expect(sections[0].title).toBe("Getting started is easy.");
  });

  it("falls back to splitting fullText when there are no structured sections", () => {
    const sections = extractContentSections(
      snapshot({ fullText: `${PROSE}\n\n${PROSE.replace("paragraph", "passage")}` }),
      NOW
    );
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.every((s) => s.text.length >= 120)).toBe(true);
  });

  it("builds searchText from title + text for the retrieval index", () => {
    const sections = extractContentSections(
      snapshot({ sections: [{ headingPath: ["Pricing"], text: PROSE, start: 0 }] }),
      NOW
    );
    expect(sections[0].searchText.startsWith("Pricing ")).toBe(true);
    expect(sections[0].searchText).toContain("substantial paragraph");
  });
});
