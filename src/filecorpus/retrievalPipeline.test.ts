import { describe, expect, it, vi } from "vitest";
import type { FileCorpus, FileUnit } from "./corpusTypes";
import { dedupeRankedUnits, runRetrieval } from "./retrievalPipeline";
import { buildIndex } from "./rankUnits";

function unit(ordinal: number, text: string, embedding?: number[]): FileUnit {
  return { id: `f:u${ordinal}`, ordinal, kind: "paragraph", text, address: { line: ordinal + 1 }, structure: {}, embedding };
}

function corpus(units: FileUnit[]): FileCorpus {
  return {
    fileId: "f",
    fileName: "demo",
    sourceType: "folder",
    fileCount: 1,
    byteSize: 0,
    ingestedAt: "2026-05-29T00:00:00.000Z",
    unitCount: units.length,
    warnings: [],
    units,
    index: buildIndex(units)
  };
}

describe("runRetrieval", () => {
  it("uses the SEMANTIC path when the corpus has vectors and the query embeds", async () => {
    const c = corpus([
      unit(0, "validates the session token on each request", [1, 0, 0]),
      unit(1, "renders the marketing homepage", [0, 0, 1])
    ]);
    const result = await runRetrieval(c, "how is auth handled", async () => [1, 0, 0]);
    expect(result.mode).toBe("semantic");
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.rendered).toContain("session token");
    expect(result.rendered).not.toContain("marketing homepage");
  });

  it("falls back to LEXICAL when the corpus has no vectors", async () => {
    const c = corpus([unit(0, "the login function authenticates the user"), unit(1, "unrelated prose about widgets")]);
    const embed = vi.fn(async () => [1, 0]);
    const result = await runRetrieval(c, "login", embed);
    expect(embed).not.toHaveBeenCalled(); // no vectors → never embeds the query
    expect(result.mode).toBe("lexical");
    expect(result.rendered).toContain("login function");
  });

  it("falls back to LEXICAL when the query cannot be embedded (no key / failure)", async () => {
    const c = corpus([unit(0, "login function", [1, 0]), unit(1, "widgets", [0, 1])]);
    const result = await runRetrieval(c, "login", async () => undefined);
    expect(result.mode).toBe("lexical");
  });

  it("falls back to LEXICAL when a thrown embedder errors", async () => {
    const c = corpus([unit(0, "login", [1, 0])]);
    const result = await runRetrieval(c, "login", async () => {
      throw new Error("network");
    });
    expect(result.mode).toBe("lexical");
  });

  it("falls back to lexical when semantic finds nothing above the relevance floor", async () => {
    // Query vector orthogonal to every unit → zero semantic hits → lexical picks
    // up the exact keyword match instead.
    const c = corpus([unit(0, "exactTokenXYZ appears here", [1, 0]), unit(1, "other", [1, 0])]);
    const result = await runRetrieval(c, "exactTokenXYZ", async () => [0, 1]);
    expect(result.mode).toBe("lexical");
    expect(result.rendered).toContain("exactTokenXYZ");
  });

  it("returns NO fixed count semantically — many relevant units all come back", async () => {
    const units = Array.from({ length: 12 }, (_, i) => unit(i, `relevant passage number ${i}`, [1, i * 0.001]));
    const c = corpus(units);
    const result = await runRetrieval(c, "q", async () => [1, 0]);
    expect(result.mode).toBe("semantic");
    expect(result.matchCount).toBe(12); // not capped at 8
  });
});

describe("dedupeRankedUnits", () => {
  it("drops duplicate primary hits, keeping the first (highest-ranked)", () => {
    const ranked = [
      { unit: unit(0, "same text"), score: 3, matchedTerms: [], pulledAsNeighbor: false },
      { unit: unit(1, "SAME   text"), score: 2, matchedTerms: [], pulledAsNeighbor: false }, // dup (normalised)
      { unit: unit(2, "different"), score: 1, matchedTerms: [], pulledAsNeighbor: false }
    ];
    const out = dedupeRankedUnits(ranked);
    expect(out.map((r) => r.unit.ordinal)).toEqual([0, 2]);
  });

  it("keeps neighbours even if they duplicate (they provide adjacency context)", () => {
    const ranked = [
      { unit: unit(0, "x"), score: 3, matchedTerms: [], pulledAsNeighbor: false },
      { unit: unit(1, "x"), score: 0, matchedTerms: [], pulledAsNeighbor: true }
    ];
    const out = dedupeRankedUnits(ranked);
    expect(out).toHaveLength(2);
  });
});
