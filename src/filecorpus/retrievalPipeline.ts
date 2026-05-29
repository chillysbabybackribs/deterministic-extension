/**
 * The deterministic retrieval pipeline for the connected file/folder corpus.
 *
 * This is the back half of "search the corpus from natural language": rank ->
 * organise -> dedupe -> structured summary. There is NO fixed top-N and NO char
 * budget — the cutoff is RELEVANCE (the embedding ranker's similarity threshold).
 * The structured summary's SHAPE bounds its size, not an arbitrary guillotine
 * that throws away relevant matches. The model is invoked once afterwards, over
 * this summary — it never walks files or reads raw units.
 *
 * Mirrors the web corpus's formatSectionsAsStructuredSummary so both corpora feed
 * synthesis the same way. Semantic-first (cosine over embeddings); falls back to
 * the lexical ranker when the corpus has no vectors or the query can't be
 * embedded (no key / embed failure) — retrieval always returns something.
 *
 * The query-embedding call is injected, so the organise/dedupe/render core is
 * pure and unit-testable.
 */

import type { FileCorpus } from "./corpusTypes";
import {
  corpusHasEmbeddings,
  describeSimilarityDistribution,
  rankUnitsBySimilarity,
  toRankedUnits,
  type SimilarityDistribution
} from "./embeddingRanker";
import {
  describeUnitLocation,
  formatRankedUnitsForModel,
  lexicalRanker,
  type RankedUnit
} from "./rankUnits";

export type RetrievalResult = {
  /** The model-facing structured summary (verbatim units + locators), or an empty-state line. */
  rendered: string;
  /** Primary hits (excludes neighbours pulled for context). */
  matchCount: number;
  /** Which engine produced the result, for the activity log + settings readout. */
  mode: "semantic" | "lexical";
  /** Calibration instrument: the query's similarity distribution (semantic path only). */
  distribution?: SimilarityDistribution;
};

/** Injected query embedder: returns the query vector, or undefined to force lexical. */
export type EmbedQuery = () => Promise<number[] | undefined>;

/**
 * Run the deterministic retrieval pipeline against the active corpus.
 *
 * Semantic when the corpus has vectors AND the query embeds; otherwise lexical.
 * `broaden` only affects the lexical fallback (wider hit set + more neighbours) —
 * the semantic path needs no broaden knob because its relevance cutoff already
 * scales the result to the query.
 */
export async function runRetrieval(
  corpus: FileCorpus,
  query: string,
  embedQuery: EmbedQuery,
  options: { broaden?: boolean } = {}
): Promise<RetrievalResult> {
  // SEMANTIC PATH — preferred when vectors exist.
  if (corpusHasEmbeddings(corpus)) {
    let queryVector: number[] | undefined;
    try {
      queryVector = await embedQuery();
    } catch {
      queryVector = undefined; // embed failed — fall through to lexical.
    }
    if (queryVector && queryVector.length) {
      const hits = rankUnitsBySimilarity(corpus, queryVector);
      if (hits.length) {
        const deduped = dedupeRankedUnits(toRankedUnits(hits));
        return {
          rendered: formatRankedUnitsForModel(deduped),
          matchCount: deduped.filter((h) => !h.pulledAsNeighbor).length,
          mode: "semantic",
          distribution: describeSimilarityDistribution(corpus, queryVector)
        };
      }
      // No semantic hits over the relevance floor — fall back to lexical so a
      // keyword-only match (e.g. an exact identifier) can still surface.
    }
  }

  // LEXICAL FALLBACK.
  const ranked = await lexicalRanker.rank(corpus, query, {
    limit: options.broaden ? 16 : 8,
    neighborRadius: options.broaden ? 2 : 1
  });
  const deduped = dedupeRankedUnits(ranked);
  return {
    rendered: formatRankedUnitsForModel(deduped),
    matchCount: deduped.filter((h) => !h.pulledAsNeighbor).length,
    mode: "lexical"
  };
}

/**
 * Drop near-identical passages so repeated content (boilerplate headers, license
 * blocks, copy-pasted code across files) doesn't crowd the summary. Keeps the
 * FIRST occurrence (highest-ranked, since input is in relevance order) and its
 * locator; later duplicates are removed. A "duplicate" is same normalised text.
 *
 * Neighbours are kept even if they duplicate — they exist to give context around
 * a specific hit, and dropping them would break the adjacency the renderer relies
 * on. Only primary hits are deduped against each other.
 */
export function dedupeRankedUnits(ranked: RankedUnit[]): RankedUnit[] {
  const seen = new Set<string>();
  const out: RankedUnit[] = [];
  for (const item of ranked) {
    if (item.pulledAsNeighbor) {
      out.push(item);
      continue;
    }
    const key = normalizeForDedup(item.unit.text);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    out.push(item);
  }
  return out;
}

function normalizeForDedup(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Re-exported so callers/tests can build locators without reaching into rankUnits. */
export { describeUnitLocation };
