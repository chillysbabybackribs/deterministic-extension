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
   * SELF-CALIBRATING cutoff: we do NOT use a guessed absolute threshold. Instead
   * we sort the query's scores and cut at the LARGEST GAP between consecutive
   * scores in the candidate range — the natural separation between the relevant
   * cluster (top) and the baseline mass (below). This adapts to each query and to
   * wherever the embedding model's baseline happens to sit, so there is no magic
   * number to tune. The options below only bound that search; they are not the
   * cutoff itself.
   */
  /** Never consider more than this many top candidates for the gap search (perf + sanity). */
  maxCandidates?: number;
  /** Minimum drop (in cosine) that counts as a real "gap"; below this the scores are too uniform to split, so keep up to `maxHits`. */
  minGap?: number;
  /**
   * Always keep at least this many of the top results before the gap is allowed
   * to cut. Stops a single dominant top unit from starving the result to 1 — its
   * close-enough neighbours come along. A floor on COUNT, not a similarity threshold.
   */
  minKeep?: number;
  /** Hard safety ceiling on returned hits — a backstop, never the normal stop. */
  maxHits?: number;
};

const DEFAULT_OPTIONS: Required<SemanticRankOptions> = {
  maxCandidates: 30,
  minGap: 0.04,
  minKeep: 4,
  maxHits: 30
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
    scored.push({ unit, score: similarity, similarity, matchedTerms: [], pulledAsNeighbor: false });
  }

  if (!scored.length) {
    return [];
  }

  scored.sort((left, right) => right.similarity - left.similarity || left.unit.ordinal - right.unit.ordinal);

  const keep = relevantCount(scored.map((s) => s.similarity), opts);
  return scored.slice(0, keep);
}

/**
 * Self-calibrating cutoff: given scores sorted descending, return how many to
 * keep by finding the LARGEST GAP between consecutive scores within the top
 * `maxCandidates`. The relevant cluster sits above that gap; the baseline mass
 * below it. No absolute threshold — the boundary comes from the query's own
 * distribution, so it adapts to focused vs. broad queries and to wherever the
 * model's baseline sits. If no gap exceeds `minGap` (scores too uniform to
 * split), keep the whole candidate window. Always keeps at least the top hit.
 */
export function relevantCount(sortedDesc: number[], options: SemanticRankOptions = {}): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!sortedDesc.length) {
    return 0;
  }
  const window = Math.min(sortedDesc.length, opts.maxCandidates, opts.maxHits);
  if (window <= 1) {
    return window;
  }
  // Always keep at least minKeep (bounded by what's available), so one dominant
  // top score can't cut the result down to a single unit.
  const minKeep = Math.min(opts.minKeep, window);

  let bestGap = 0;
  let cutAfter = window; // default: keep the whole window (no decisive gap)
  // Search for the cut only at or beyond minKeep — the floor cluster is always kept.
  for (let i = Math.max(0, minKeep - 1); i < window - 1; i += 1) {
    const gap = sortedDesc[i] - sortedDesc[i + 1];
    if (gap > bestGap) {
      bestGap = gap;
      cutAfter = i + 1; // keep indices [0..i]
    }
  }

  // Only trust the gap if it's a real separation; otherwise the distribution is
  // too uniform to split meaningfully — keep the candidate window.
  if (bestGap < opts.minGap) {
    return window;
  }
  return Math.max(cutAfter, minKeep);
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
  /** The largest gap found (the self-calibrating cut point's size). */
  gap: number;
  /** How many the gap-based cutoff keeps (the actual returned count). */
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
  const kept = relevantCount(sims, opts);
  // The size of the gap we cut at, for the calibration readout.
  const window = Math.min(sims.length, opts.maxCandidates, opts.maxHits);
  let gap = 0;
  for (let i = 0; i < window - 1; i += 1) {
    gap = Math.max(gap, sims[i] - sims[i + 1]);
  }
  return {
    comparable: sims.length,
    top: round(sims[0]),
    median: round(sims[Math.floor(sims.length / 2)]),
    min: round(sims[sims.length - 1]),
    gap: round(gap),
    kept
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
