import { describe, expect, it } from "vitest";
import type { FileCorpus, FileUnit, UnitKind } from "./corpusTypes";
import {
  buildIndex,
  extendIndex,
  formatRankedUnitsForModel,
  lexicalRanker,
  rankUnits
} from "./rankUnits";

type UnitSeed = {
  text: string;
  kind?: UnitKind;
  isHeading?: boolean;
  headerColumns?: string[];
  headingPath?: string[];
  rowIndex?: number;
  sheet?: string;
  page?: number;
  path?: string;
};

function makeCorpus(seeds: UnitSeed[]): FileCorpus {
  const units: FileUnit[] = seeds.map((seed, index) => ({
    id: `f:u${index}`,
    ordinal: index,
    kind: seed.kind ?? "paragraph",
    text: seed.text,
    address: {
      path: seed.path,
      headingPath: seed.headingPath,
      rowIndex: seed.rowIndex,
      sheet: seed.sheet,
      page: seed.page
    },
    structure: { isHeading: seed.isHeading, headerColumns: seed.headerColumns }
  }));

  return {
    fileId: "f",
    fileName: "test.txt",
    sourceType: "file",
    sourceKind: "text",
    byteSize: 0,
    ingestedAt: "2026-05-29T00:00:00.000Z",
    unitCount: units.length,
    warnings: [],
    units,
    index: buildIndex(units)
  };
}

describe("rankUnits TF-IDF scoring", () => {
  it("ranks a unit with the rare query term above one with only a common term", () => {
    // "data" is common (appears in 3 units), "encryption" is rare (1 unit).
    const corpus = makeCorpus([
      { text: "data data data common everywhere" },
      { text: "data data again here too" },
      { text: "general data discussion paragraph" },
      { text: "encryption data: the rare discriminating passage about data" }
    ]);

    const ranked = rankUnits(corpus, "encryption data", { neighborRadius: 0 });
    expect(ranked[0].unit.ordinal).toBe(3);
    expect(ranked[0].matchedTerms).toContain("encryption");
  });

  it("returns empty for an empty or stopword-only query", () => {
    const corpus = makeCorpus([{ text: "anything here at all" }]);
    expect(rankUnits(corpus, "")).toEqual([]);
    expect(rankUnits(corpus, "the and of")).toEqual([]);
  });

  it("breaks ties deterministically by ordinal", () => {
    const corpus = makeCorpus([
      { text: "alpha widget specification" },
      { text: "alpha widget specification" }
    ]);
    const ranked = rankUnits(corpus, "widget", { neighborRadius: 0 });
    expect(ranked.map((item) => item.unit.ordinal)).toEqual([0, 1]);
  });

  it("respects word boundaries (does not match partial words)", () => {
    const corpus = makeCorpus([
      { text: "the cat sat on the mat" },
      { text: "category theory is abstract" }
    ]);
    const ranked = rankUnits(corpus, "cat", { neighborRadius: 0 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].unit.ordinal).toBe(0);
  });
});

describe("rankUnits structural boosts", () => {
  it("boosts a heading unit over a plain paragraph with the same match", () => {
    const corpus = makeCorpus([
      { text: "pricing tiers overview paragraph", isHeading: false },
      { text: "pricing tiers", isHeading: true, kind: "section" }
    ]);
    const ranked = rankUnits(corpus, "pricing tiers", { neighborRadius: 0, headingBoost: 3 });
    expect(ranked[0].unit.ordinal).toBe(1);
  });

  it("boosts a row when a query term matches a column header", () => {
    const corpus = makeCorpus([
      { text: "Name: Acme | Revenue: 100", kind: "row", headerColumns: ["Name", "Revenue"], rowIndex: 1 },
      { text: "some revenue mentioned in prose paragraph here", kind: "paragraph" }
    ]);
    const ranked = rankUnits(corpus, "revenue", { neighborRadius: 0, columnHeaderBoost: 5 });
    expect(ranked[0].unit.kind).toBe("row");
  });
});

describe("rankUnits neighbor pulling", () => {
  it("pulls ±radius prose neighbors as context, ordered by ordinal", () => {
    const corpus = makeCorpus([
      { text: "intro paragraph before the match" },
      { text: "the unique keyword lives here" },
      { text: "follow-up paragraph after the match" }
    ]);
    const ranked = rankUnits(corpus, "keyword", { neighborRadius: 1, limit: 1 });
    // Relevance order: the hit (ordinal 1) first, then its neighbors in doc order.
    expect(ranked.map((item) => item.unit.ordinal)).toEqual([1, 0, 2]);
    expect(ranked.find((item) => item.unit.ordinal === 1)?.pulledAsNeighbor).toBe(false);
    expect(ranked.find((item) => item.unit.ordinal === 0)?.pulledAsNeighbor).toBe(true);
    expect(ranked.find((item) => item.unit.ordinal === 2)?.pulledAsNeighbor).toBe(true);
  });

  it("does not pull neighbors for tabular rows", () => {
    const corpus = makeCorpus([
      { text: "Name: A | Note: filler", kind: "row", rowIndex: 1 },
      { text: "Name: B | Note: the keyword row", kind: "row", rowIndex: 2 },
      { text: "Name: C | Note: filler", kind: "row", rowIndex: 3 }
    ]);
    const ranked = rankUnits(corpus, "keyword", { neighborRadius: 2, limit: 1 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].unit.address.rowIndex).toBe(2);
  });
});

describe("lexicalRanker + formatting", () => {
  it("lexicalRanker delegates to rankUnits", () => {
    const corpus = makeCorpus([{ text: "the searchable keyword passage" }]);
    const ranked = lexicalRanker.rank(corpus, "keyword") as ReturnType<typeof rankUnits>;
    expect(ranked).toHaveLength(1);
  });

  it("describes clean numbered-section + line locators", () => {
    const corpus = makeCorpus([
      { text: "SQLmap - Automated SQL injection detection", headingPath: ["SQL Injection Testing"] }
    ]);
    // Stamp a section number + line as the parser would.
    corpus.units[0].address.sectionNumber = "9";
    corpus.units[0].address.line = 58;
    const rendered = formatRankedUnitsForModel(rankUnits(corpus, "sqlmap", { neighborRadius: 0 }));
    expect(rendered).toContain("§9 SQL Injection Testing · line 58");
  });

  it("prefixes the source file path in folder-corpus locators", () => {
    const corpus = makeCorpus([
      { text: "export function login() {}", headingPath: ["auth"], path: "src/auth/login.ts" }
    ]);
    corpus.units[0].address.line = 12;
    const rendered = formatRankedUnitsForModel(rankUnits(corpus, "login", { neighborRadius: 0 }));
    expect(rendered).toContain("src/auth/login.ts › auth · line 12");
  });

  it("describes a spreadsheet locator as Sheet + row", () => {
    const corpus = makeCorpus([
      { text: "Name: Acme | Revenue: 100", kind: "row", rowIndex: 14, sheet: "Q3", headerColumns: ["Name", "Revenue"] }
    ]);
    const rendered = formatRankedUnitsForModel(rankUnits(corpus, "revenue", { neighborRadius: 0 }));
    expect(rendered).toContain("Sheet 'Q3' · row 14");
  });

  it("formats ranked units with locators and a no-match fallback", () => {
    const corpus = makeCorpus([
      { text: "Enterprise plan details", headingPath: ["Pricing", "Enterprise"] }
    ]);
    const ranked = rankUnits(corpus, "enterprise", { neighborRadius: 0 });
    const rendered = formatRankedUnitsForModel(ranked);
    expect(rendered).toContain("Pricing › Enterprise");
    expect(rendered).toContain("Enterprise plan details");

    expect(formatRankedUnitsForModel([])).toContain("No matching passages");
  });
});

describe("extendIndex", () => {
  it("matches buildIndex over the union of units", () => {
    const all: FileUnit[] = [
      { id: "u0", ordinal: 0, kind: "paragraph", text: "alpha beta gamma", address: {}, structure: {} },
      { id: "u1", ordinal: 1, kind: "paragraph", text: "beta delta", address: {}, structure: {} },
      { id: "u2", ordinal: 2, kind: "paragraph", text: "gamma gamma epsilon", address: {}, structure: {} }
    ];
    const full = buildIndex(all);

    // Build incrementally: first unit, then extend with the rest.
    const incremental = buildIndex(all.slice(0, 1));
    extendIndex(incremental, all.slice(1));

    expect(incremental.n).toBe(full.n);
    expect(incremental.df).toEqual(full.df);
    expect(incremental.tf).toEqual(full.tf);
  });

  it("is idempotent for already-indexed units", () => {
    const units: FileUnit[] = [
      { id: "u0", ordinal: 0, kind: "paragraph", text: "alpha beta", address: {}, structure: {} }
    ];
    const index = buildIndex(units);
    extendIndex(index, units); // re-adding the same unit must not double-count
    expect(index.n).toBe(1);
    expect(index.df.alpha).toBe(1);
  });
});
