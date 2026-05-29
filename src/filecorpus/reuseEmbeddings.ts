/**
 * Reuse embeddings across re-ingests so reconnecting a folder doesn't re-embed
 * unchanged content.
 *
 * Embeddings are deterministic: the same text under the same model/dimension
 * always produces the same vector. So we key a lookup by the unit's text (+ the
 * vector dimension, so a corpus embedded at an old dimension isn't reused after
 * we change EMBEDDING_DIMENSIONS). On re-ingest, any new unit whose text matches
 * a prior unit gets its vector pre-filled — and since embedUnits only sends units
 * MISSING a vector, those are skipped automatically. Unchanged files cost zero
 * API calls; only genuinely new/edited content is embedded.
 *
 * Keyed on text rather than file path on purpose: a moved or renamed file with
 * identical content still reuses its vectors, and an edited file's changed units
 * correctly miss and get re-embedded.
 */

import type { FileCorpus, FileUnit } from "./corpusTypes";

export type EmbeddingReuseIndex = {
  /** Vector dimension these entries were embedded at; reuse only matches this dimension. */
  dimensions: number;
  /** normalizedText -> vector */
  byText: Map<string, number[]>;
};

function key(text: string): string {
  return text.trim();
}

/** Build a reuse index from a prior corpus's embedded units. Empty when none are embedded. */
export function buildReuseIndex(prior: FileCorpus | undefined): EmbeddingReuseIndex {
  const byText = new Map<string, number[]>();
  let dimensions = 0;
  if (prior) {
    for (const unit of prior.units) {
      if (unit.embedding && unit.embedding.length) {
        if (!dimensions) {
          dimensions = unit.embedding.length;
        }
        if (unit.embedding.length === dimensions) {
          byText.set(key(unit.text), unit.embedding);
        }
      }
    }
  }
  return { dimensions, byText };
}

/**
 * Pre-fill `embedding` on units whose text matches a reusable vector of the
 * expected dimension. Returns a new array; counts how many were reused. Units
 * with no match are left untouched (the embedder fills them in later).
 */
export function applyReusedEmbeddings(
  units: FileUnit[],
  reuse: EmbeddingReuseIndex | undefined,
  expectedDimensions: number
): { units: FileUnit[]; reused: number } {
  if (!reuse || !reuse.byText.size || reuse.dimensions !== expectedDimensions) {
    return { units, reused: 0 };
  }
  let reused = 0;
  const next = units.map((unit) => {
    if (unit.embedding && unit.embedding.length) {
      return unit; // already has a vector
    }
    const vector = reuse.byText.get(key(unit.text));
    if (vector) {
      reused += 1;
      return { ...unit, embedding: vector };
    }
    return unit;
  });
  return { units: next, reused };
}
