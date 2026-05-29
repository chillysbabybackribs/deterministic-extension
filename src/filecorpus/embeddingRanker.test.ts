import { describe, expect, it } from "vitest";
import type { FileCorpus, FileUnit } from "./corpusTypes";
import {
  corpusHasEmbeddings,
  cosineSimilarity,
  describeSimilarityDistribution,
  embeddingRanker,
  rankUnitsBySimilarity,
  toRankedUnits
} from "./embeddingRanker";

function unit(ordinal: number, text: string, embedding?: number[]): FileUnit {
  return {
    id: `f:u${ordinal}`,
    ordinal,
    kind: "paragraph",
    text,
    address: {},
    structure: {},
    embedding
  };
}

function corpus(units: FileUnit[]): FileCorpus {
  return {
    fileId: "f",
    fileName: "demo",
    sourceType: "folder",
    byteSize: 0,
    ingestedAt: "2026-05-29T00:00:00.000Z",
    unitCount: units.length,
    warnings: [],
    units,
    index: { n: units.length, df: {}, tf: {} }
  };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, and 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("rankUnitsBySimilarity", () => {
  it("matches by MEANING, not shared words: the query vector lands on the semantically-near unit", () => {
    // The "auth" query vector points the same way as the session/token unit,
    // which shares ZERO words with the query — the whole point of semantic search.
    const queryVector = [1, 0, 0];
    const c = corpus([
      unit(0, "validates the session token on each request", [0.96, 0.1, 0.1]), // near
      unit(1, "renders the marketing homepage hero banner", [0, 0.2, 0.97]), // far
      unit(2, "refreshes the login credential before expiry", [0.9, 0.2, 0.05]) // near
    ]);

    const ranked = rankUnitsBySimilarity(c, queryVector);
    const texts = ranked.map((r) => r.unit.text);

    expect(texts).toContain("validates the session token on each request");
    expect(texts).toContain("refreshes the login credential before expiry");
    expect(texts).not.toContain("renders the marketing homepage hero banner");
    // Most-similar first.
    expect(ranked[0].unit.ordinal).toBe(0);
  });

  it("returns NO fixed count — a broad query keeps every comparably-relevant unit", () => {
    const queryVector = [1, 0];
    // Ten units all very close to the query: a broad question keeps them all.
    const units = Array.from({ length: 10 }, (_, i) => unit(i, `relevant ${i}`, [1, i * 0.001]));
    const ranked = rankUnitsBySimilarity(corpus(units), queryVector);
    expect(ranked).toHaveLength(10);
  });

  it("a focused query returns only the tight cluster, dropping the long tail via the relative margin", () => {
    const queryVector = [1, 0];
    const c = corpus([
      unit(0, "bullseye", [1, 0]), // sim ~1.0
      unit(1, "close", [0.99, 0.14]), // sim ~0.99, within margin
      unit(2, "mediocre", [0.7, 0.71]) // sim ~0.70, outside the 0.18 margin from 1.0
    ]);
    const ranked = rankUnitsBySimilarity(c, queryVector);
    const texts = ranked.map((r) => r.unit.text);
    expect(texts).toEqual(["bullseye", "close"]);
  });

  it("drops the unrelated tail below the absolute similarity floor", () => {
    const queryVector = [1, 0];
    const c = corpus([
      unit(0, "near", [1, 0]),
      unit(1, "unrelated", [0, 1]) // cosine 0, below minSimilarity
    ]);
    const ranked = rankUnitsBySimilarity(c, queryVector);
    expect(ranked.map((r) => r.unit.text)).toEqual(["near"]);
  });

  it("skips units with no vector or a mismatched dimension (lexical fallback covers those)", () => {
    const queryVector = [1, 0, 0];
    const c = corpus([
      unit(0, "no vector"),
      unit(1, "wrong dims", [1, 0]),
      unit(2, "good", [1, 0, 0])
    ]);
    const ranked = rankUnitsBySimilarity(c, queryVector);
    expect(ranked.map((r) => r.unit.text)).toEqual(["good"]);
  });

  it("returns [] for an empty query vector or an empty corpus", () => {
    expect(rankUnitsBySimilarity(corpus([unit(0, "x", [1])]), [])).toEqual([]);
    expect(rankUnitsBySimilarity(corpus([]), [1])).toEqual([]);
  });
});

describe("describeSimilarityDistribution", () => {
  it("reports top/median/min and how many clear each threshold", () => {
    const queryVector = [1, 0];
    const c = corpus([
      unit(0, "a", [1, 0]), // sim 1.0
      unit(1, "b", [0.99, 0.14]), // ~0.99
      unit(2, "c", [0.7, 0.71]), // ~0.70 (below 0.18 margin from 1.0)
      unit(3, "d", [0, 1]) // 0.0 (below floor)
    ]);
    const dist = describeSimilarityDistribution(c, queryVector);
    expect(dist?.comparable).toBe(4);
    expect(dist?.top).toBeCloseTo(1, 1);
    expect(dist?.aboveFloor).toBe(3); // three clear 0.55
    expect(dist?.kept).toBe(2); // only the tight cluster survives the margin
  });

  it("returns undefined when nothing is comparable", () => {
    expect(describeSimilarityDistribution(corpus([unit(0, "x")]), [1, 0])).toBeUndefined();
    expect(describeSimilarityDistribution(corpus([unit(0, "x", [1, 0])]), [])).toBeUndefined();
  });
});

describe("corpusHasEmbeddings", () => {
  it("detects whether any unit carries a vector", () => {
    expect(corpusHasEmbeddings(corpus([unit(0, "x", [1, 2])]))).toBe(true);
    expect(corpusHasEmbeddings(corpus([unit(0, "x")]))).toBe(false);
  });
});

describe("embeddingRanker (seam)", () => {
  it("embeds the query lazily and ranks; returns [] (no embed call) when the corpus has no vectors", async () => {
    let embedCalls = 0;
    const noVectors = corpus([unit(0, "x")]);
    const out = await embeddingRanker.rank(noVectors, async () => {
      embedCalls += 1;
      return [1, 0];
    });
    expect(out).toEqual([]);
    expect(embedCalls).toBe(0); // short-circuits before the network call.
  });

  it("embeds once and ranks when vectors are present", async () => {
    const c = corpus([unit(0, "near", [1, 0]), unit(1, "far", [0, 1])]);
    const out = await embeddingRanker.rank(c, async () => [1, 0]);
    expect(out.map((r) => r.unit.text)).toEqual(["near"]);
  });
});

describe("toRankedUnits", () => {
  it("strips the similarity field, leaving a plain RankedUnit[]", () => {
    const c = corpus([unit(0, "x", [1, 0])]);
    const hits = rankUnitsBySimilarity(c, [1, 0]);
    const plain = toRankedUnits(hits);
    expect(plain[0]).not.toHaveProperty("similarity");
    expect(plain[0].unit.text).toBe("x");
  });
});
