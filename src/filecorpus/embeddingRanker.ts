/**
 * The semantic (vector) retrieval engine.
 *
 * The natural-language prompt is embedded into the same vector space as the
 * corpus units, then every unit is scored by cosine similarity to the query.
 * This matches by MEANING, not literal words: "how is auth handled" lands on a
 * unit that says "validates the session token" even though they share no terms —
 * which is the whole point of a corpus you can search from natural language.
 *
 * NO FIXED TOP-N AND NO CHAR BUDGET. The cutoff is RELEVANCE, computed
 * deterministically: include every unit at or above an absolute floor AND within
 * a relative margin of the best hit. A tightly-focused query returns a few
 * units; a broad "review the whole thing" query returns many — bounded by what
 * is actually relevant, not by an arbitrary count. The downstream pipeline
 * (organise -> dedupe -> structured summary) is what shapes the size from there.
 *
 * Implements the same UnitRanker interface as the lexical ranker, so it drops
 * into queryCorpus as a one-line swap. When the query vector is unavailable
 * (no API key / embed failure) the caller falls back to lexicalRanker.
 *
 * Pure: the query vector is passed in already embedded (the async Gemini call
 * lives in geminiEmbeddingClient), so ranking itself is deterministic and
 * unit-testable with hand-built vectors.
 */

import type { FileCorpus, FileUnit } from "./corpusTypes";
import type { RankedUnit } from "./rankUnits";

export type SemanticRankOptions = {
  /**
   * Absolute cosine floor — a unit must be at least this similar to the query to
   * be considered relevant at all. Filters out the long tail of unrelated units.
   */
  minSimilarity?: number;
  /**
   * Relative margin below the top hit. A unit is kept only if its similarity is
   * within `relativeMargin` of the best unit's similarity, so a single strong
   * match doesn't drag in a pile of mediocre ones, while a broad query with many
   * comparably-relevant units keeps them all.
   */
  relativeMargin?: number;
  /**
   * Hard safety ceiling on returned hits — NOT a relevance budget. It only
   * guards against a pathological query that is "relevant" to nearly everything;
   * in normal use the relevance cutoffs bite first. Generous on purpose.
   */
  maxHits?: number;
};

/**
 * Defaults tuned for cosine similarity on normalised-ish embeddings. These are
 * the single, documented relevance knobs — not a budget. minSimilarity drops the
 * unrelated tail; relativeMargin keeps the cohesive cluster around the top hit.
 */
const DEFAULT_OPTIONS: Required<SemanticRankOptions> = {
  minSimilarity: 0.55,
  relativeMargin: 0.18,
  maxHits: 200
};

export type SemanticRankedUnit = RankedUnit & {
  /** Raw cosine similarity to the query, for inspection/debugging. */
  similarity: number;
};

/**
 * Rank a corpus against an already-embedded query vector. Returns the relevant
 * units in descending similarity order — every unit that clears the relevance
 * cutoff, no fixed count. Returns [] when the corpus has no embedded units (the
 * caller should then fall back to lexical ranking).
 */
export function rankUnitsBySimilarity(
  corpus: FileCorpus,
  queryVector: number[],
  options: SemanticRankOptions = {}
): SemanticRankedUnit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!queryVector.length || !corpus.units.length) {
    return [];
  }

  const scored: SemanticRankedUnit[] = [];
  for (const unit of corpus.units) {
    if (!unit.embedding || unit.embedding.length !== queryVector.length) {
      continue; // no comparable vector — skip; lexical fallback covers it.
    }
    const similarity = cosineSimilarity(queryVector, unit.embedding);
    if (similarity < opts.minSimilarity) {
      continue;
    }
    scored.push({ unit, score: similarity, similarity, matchedTerms: [], pulledAsNeighbor: false });
  }

  if (!scored.length) {
    return [];
  }

  scored.sort((left, right) => right.similarity - left.similarity || left.unit.ordinal - right.unit.ordinal);

  // Relevance cutoff: keep the cohesive cluster within `relativeMargin` of the
  // top hit. This is what makes "no budget" deterministic — the boundary is set
  // by the query's own relevance gradient, not a count.
  const topSimilarity = scored[0].similarity;
  const floor = topSimilarity - opts.relativeMargin;
  const relevant = scored.filter((hit) => hit.similarity >= floor);

  // The ceiling is a safety net, never the normal stopping condition.
  return relevant.slice(0, opts.maxHits);
}

/** True when at least one unit carries a vector — i.e. semantic ranking is possible. */
export function corpusHasEmbeddings(corpus: FileCorpus): boolean {
  return corpus.units.some((unit) => Array.isArray(unit.embedding) && unit.embedding.length > 0);
}

export type SimilarityDistribution = {
  /** Units that have a comparable vector. */
  comparable: number;
  top: number;
  median: number;
  min: number;
  /** How many clear the absolute floor (minSimilarity). */
  aboveFloor: number;
  /** How many survive the relative-margin cutoff (the actual returned count). */
  kept: number;
};

/**
 * Measure how the corpus's cosine similarities to a query are distributed. This
 * is the calibration instrument: run a real query, read top/median/min and how
 * many clear each threshold, then set minSimilarity/relativeMargin from the data
 * instead of guessing. Returns undefined when nothing is comparable.
 */
export function describeSimilarityDistribution(
  corpus: FileCorpus,
  queryVector: number[],
  options: SemanticRankOptions = {}
): SimilarityDistribution | undefined {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!queryVector.length) {
    return undefined;
  }
  const sims: number[] = [];
  for (const unit of corpus.units) {
    if (unit.embedding && unit.embedding.length === queryVector.length) {
      sims.push(cosineSimilarity(queryVector, unit.embedding));
    }
  }
  if (!sims.length) {
    return undefined;
  }
  sims.sort((a, b) => b - a);
  const top = sims[0];
  const aboveFloor = sims.filter((s) => s >= opts.minSimilarity).length;
  const kept = sims.filter((s) => s >= opts.minSimilarity && s >= top - opts.relativeMargin).length;
  return {
    comparable: sims.length,
    top: round(top),
    median: round(sims[Math.floor(sims.length / 2)]),
    min: round(sims[sims.length - 1]),
    aboveFloor,
    kept: Math.min(kept, opts.maxHits)
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for a zero-magnitude
 * vector (avoids NaN). Assumes callers pass same-length vectors; mismatched
 * lengths are filtered out before this is called.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Strip the per-hit similarity so the result is a plain RankedUnit[] for the shared formatter. */
export function toRankedUnits(hits: SemanticRankedUnit[]): RankedUnit[] {
  return hits.map(({ unit, score, matchedTerms, pulledAsNeighbor }) => ({
    unit,
    score,
    matchedTerms,
    pulledAsNeighbor
  }));
}

/** A semantic unit ranker. Async because embedding the query is a network call;
 * the pure ranking is rankUnitsBySimilarity, which this wraps once the query
 * vector is available. Kept here as the seam-compatible entry the wiring slice
 * will use; the embed step is injected so this stays testable. */
export interface SemanticRanker {
  rank(
    corpus: FileCorpus,
    embedQuery: () => Promise<number[]>,
    options?: SemanticRankOptions
  ): Promise<SemanticRankedUnit[]>;
}

export const embeddingRanker: SemanticRanker = {
  async rank(corpus, embedQuery, options) {
    if (!corpusHasEmbeddings(corpus)) {
      return [];
    }
    const queryVector = await embedQuery();
    return rankUnitsBySimilarity(corpus, queryVector, options);
  }
};
