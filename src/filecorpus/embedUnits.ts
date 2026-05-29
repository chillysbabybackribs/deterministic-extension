/**
 * The ingest-time embedding pass: turn a set of FileUnits into the same units
 * with `embedding` filled in, by calling an injected batch embedder.
 *
 * Injected, not imported directly, for two reasons: (1) ingest stays free of any
 * network coupling and is unit-testable with a fake embedder, and (2) the caller
 * owns the API key / settings (see App.tsx wiring). The real embedder is
 * geminiEmbeddingClient.embedTexts adapted to the EmbedTexts shape.
 *
 * GRACEFUL DEGRADE is the contract: if there is no embedder, or it throws, the
 * units come back UNCHANGED (no `embedding`). Retrieval then falls back to
 * lexical ranking for those units — embedding never breaks ingest.
 *
 * Only units missing an `embedding` are sent, so re-running over a partially
 * embedded corpus (e.g. a resumed folder trickle) is cheap and idempotent.
 */

import type { FileUnit } from "./corpusTypes";

/** Batch embedder: texts in, index-aligned vectors out. Injected at the call site. */
export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

export type EmbedUnitsResult = {
  units: FileUnit[];
  /** How many units gained a vector in this pass. */
  embedded: number;
  /** Non-fatal note when embedding was skipped or failed (surfaced as a corpus warning). */
  warning?: string;
};

/**
 * Embed every not-yet-embedded unit. Returns a NEW units array (the embedded
 * ones replaced with `{...unit, embedding}`); on any failure returns the units
 * untouched with a warning. Never throws.
 */
export async function embedUnits(units: FileUnit[], embed: EmbedTexts | undefined): Promise<EmbedUnitsResult> {
  if (!embed) {
    return { units, embedded: 0 };
  }

  const pending: number[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if ((!u.embedding || u.embedding.length === 0) && u.text.trim().length > 0) {
      pending.push(i);
    }
  }
  if (!pending.length) {
    return { units, embedded: 0 };
  }

  let vectors: number[][];
  try {
    vectors = await embed(pending.map((i) => units[i].text));
  } catch (error) {
    return {
      units,
      embedded: 0,
      warning: `Semantic embedding skipped: ${error instanceof Error ? error.message : "embedding failed"}. Search uses keyword matching.`
    };
  }

  if (vectors.length !== pending.length) {
    return {
      units,
      embedded: 0,
      warning: "Semantic embedding skipped: embedder returned a mismatched vector count. Search uses keyword matching."
    };
  }

  const next = units.slice();
  let embedded = 0;
  for (let k = 0; k < pending.length; k += 1) {
    const vector = vectors[k];
    if (Array.isArray(vector) && vector.length > 0) {
      next[pending[k]] = { ...next[pending[k]], embedding: vector };
      embedded += 1;
    }
  }
  return { units: next, embedded };
}
