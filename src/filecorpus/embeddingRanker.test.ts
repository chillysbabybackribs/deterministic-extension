import { describe, expect, it } from "vitest";
import type { FileCorpus, FileUnit } from "./corpusTypes";
import {
  corpusHasEmbeddings,
  cosineSimilarity,
  describeSimilarityDistribution,
  embeddingRanker,
  rankUnitsBySimilarity,
  relevantCount,
  toRankedUnits
} from "./embeddingRanker";

describe("relevantCount (self-calibrating gap cutoff)", () => {
  it("cuts at the largest gap once past the minKeep floor", () => {
    // minKeep=4; a decisive drop after index 5 → keep 6.
    expect(relevantCount([0.9, 0.89, 0.88, 0.87, 0.86, 0.85, 0.5, 0.49])).toBe(6);
  });

  it("keeps the window when scores are too uniform to split (gap < minGap)", () => {
    expect(relevantCount([0.8, 0.795, 0.79, 0.785, 0.78])).toBe(5);
  });

  it("minKeep floor: a single dominant top score cannot starve the result to 1", () => {
    // Without the floor the first gap (0.95->0.6) would cut to 1; minKeep=4 keeps
    // the cluster (the uniform tail past minKeep has no decisive gap → keep window).
    expect(relevantCount([0.95, 0.6, 0.59, 0.58, 0.57])).toBe(5);
  });

  it("respects minKeep bounded by what's available", () => {
    expect(relevantCount([0.95, 0.6])).toBe(2); // only 2 exist → keep 2
  });

  it("handles empty / single", () => {
    expect(relevantCount([])).toBe(0);
    expect(relevantCount([0.7])).toBe(1);
  });
});

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

    // minKeep:1 isolates the meaning/gap behavior on this 3-unit fixture.
    const ranked = rankUnitsBySimilarity(c, queryVector, { minKeep: 1 });
    const texts = ranked.map((r) => r.unit.text);

    expect(texts).toContain("validates the session token on each request");
    expect(texts).toContain("refreshes the login credential before expiry");
    expect(texts).not.toContain("renders the marketing homepage hero banner");
    // Most-similar first.
    expect(ranked[0].unit.ordinal).toBe(0);
  });

  it("returns NO fixed count — a broad query with a uniform top keeps the whole cluster", () => {
    const queryVector = [1, 0];
    // Ten units all near-identical to the query (no decisive gap): keep them all.
    const units = Array.from({ length: 10 }, (_, i) => unit(i, `relevant ${i}`, [1, i * 0.0005]));
    const ranked = rankUnitsBySimilarity(corpus(units), queryVector);
    expect(ranked).toHaveLength(10);
  });

  it("self-calibrates: cuts at the largest gap between the relevant cluster and the baseline", () => {
    const queryVector = [1, 0];
    const c = corpus([
      unit(0, "bullseye", [1, 0]), // ~1.0   ┐ relevant cluster
      unit(1, "close", [0.995, 0.1]), // ~0.995 ┘
      unit(2, "baseline-a", [0.7, 0.71]), // ~0.70  ┐ baseline mass (big gap above)
      unit(3, "baseline-b", [0.69, 0.72]) // ~0.69  ┘
    ]);
    // minKeep:1 isolates the gap logic from the count floor for this small fixture.
    const ranked = rankUnitsBySimilarity(c, queryVector, { minKeep: 1 });
    expect(ranked.map((r) => r.unit.text)).toEqual(["bullseye", "close"]);
  });

  it("drops the unrelated tail via the gap (a near-orthogonal unit is far below)", () => {
    const queryVector = [1, 0];
    const c = corpus([
      unit(0, "near", [1, 0]), // ~1.0
      unit(1, "unrelated", [0, 1]) // ~0.0 — huge gap, dropped
    ]);
    const ranked = rankUnitsBySimilarity(c, queryVector, { minKeep: 1 });
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
  it("reports top/median/min, the gap, and the gap-based kept count", () => {
    const queryVector = [1, 0];
    // One clean split: a tight top cluster (~1.0, ~0.995) then a baseline plateau
    // (~0.70, ~0.69) — the single biggest gap sits between them.
    const c = corpus([
      unit(0, "a", [1, 0]), // ~1.0   ┐ cluster
      unit(1, "b", [0.995, 0.1]), // ~0.995 ┘
      unit(2, "c", [0.7, 0.714]), // ~0.70  ┐ baseline plateau
      unit(3, "d", [0.69, 0.724]) // ~0.69  ┘
    ]);
    const dist = describeSimilarityDistribution(c, queryVector, { minKeep: 1 });
    expect(dist?.comparable).toBe(4);
    expect(dist?.top).toBeCloseTo(1, 1);
    expect(dist?.gap).toBeGreaterThan(0.1); // decisive separation found
    expect(dist?.kept).toBe(2); // cut at the largest gap → top cluster only
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
    const out = await embeddingRanker.rank(c, async () => [1, 0], { minKeep: 1 });
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
