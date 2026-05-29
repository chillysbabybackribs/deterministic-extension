/**
 * The deterministic file-corpus search engine.
 *
 * The user's prompt is the query. We rank every mapped unit against the query
 * terms with TF-IDF-weighted overlap (a rare, discriminating term outweighs a
 * common one), apply light structural boosts (heading / column-header), and
 * pull a small neighbor window around each hit so the model gets surrounding
 * context. No model is in the retrieval loop — same query, same ranking.
 *
 * The scoring nucleus generalizes pageSnapshot.ts `extractTargetedSections`,
 * dropping its page-specific numeric boost and top-of-page position prior.
 */

import { clipWithTruncation, termMatch, tokenize } from "../shared/textUtils";
import type { CorpusIndex, FileCorpus, FileUnit } from "./corpusTypes";

export type RankOptions = {
  /** Max number of primary hits before neighbor pulling. */
  limit?: number;
  /** Pull units within ±radius ordinal of each hit. Forced to 0 for tabular kinds. */
  neighborRadius?: number;
  /** Multiplier when a hit is itself a heading unit. */
  headingBoost?: number;
  /** Multiplier when a query term matches one of the unit's column headers. */
  columnHeaderBoost?: number;
};

export type RankedUnit = {
  unit: FileUnit;
  score: number;
  matchedTerms: string[];
  /** True when this unit was added as context around a hit, not a hit itself. */
  pulledAsNeighbor: boolean;
};

const DEFAULT_OPTIONS: Required<RankOptions> = {
  limit: 8,
  neighborRadius: 1,
  headingBoost: 1.5,
  columnHeaderBoost: 1.4
};

/** Render budget for the model-facing summary (matches the fat-tool summary cap). */
const RENDER_MAX_CHARS = 24_000;
const PER_UNIT_MAX_CHARS = 1_800;

/**
 * Build the precomputed TF-IDF index for a set of units. Pure; called once at
 * ingest time and persisted with the corpus.
 */
export function buildIndex(units: FileUnit[]): CorpusIndex {
  const df: Record<string, number> = {};
  const tf: Record<string, Record<string, number>> = {};

  for (const unit of units) {
    const counts: Record<string, number> = {};
    for (const token of tokenize(unit.text)) {
      counts[token] = (counts[token] ?? 0) + 1;
    }
    tf[unit.id] = counts;
    for (const token of Object.keys(counts)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }

  return { n: units.length, df, tf };
}

/**
 * Extend an existing index with more units in place — used by the folder trickle
 * to grow the index without re-tokenizing everything each batch. df/tf are
 * additive, so this is equivalent to buildIndex over the union (each unit id is
 * counted once; pass only NEW units).
 */
export function extendIndex(index: CorpusIndex, newUnits: FileUnit[]): CorpusIndex {
  for (const unit of newUnits) {
    if (index.tf[unit.id]) {
      continue; // already indexed — keep idempotent.
    }
    const counts: Record<string, number> = {};
    for (const token of tokenize(unit.text)) {
      counts[token] = (counts[token] ?? 0) + 1;
    }
    index.tf[unit.id] = counts;
    for (const token of Object.keys(counts)) {
      index.df[token] = (index.df[token] ?? 0) + 1;
    }
    index.n += 1;
  }
  return index;
}

function idf(index: CorpusIndex, term: string): number {
  return Math.log(1 + index.n / (1 + (index.df[term] ?? 0)));
}

/**
 * Rank a corpus against query terms. `query` may be raw text or pre-split
 * terms — it is tokenized either way so callers can pass the user's prompt
 * directly.
 */
export function rankUnits(
  corpus: FileCorpus,
  query: string | string[],
  options: RankOptions = {}
): RankedUnit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rawTerms = Array.isArray(query) ? query : tokenize(query);
  const terms = Array.from(new Set(rawTerms.flatMap((term) => tokenize(term))));
  if (!terms.length || !corpus.units.length) {
    return [];
  }

  const byOrdinal = new Map<number, FileUnit>();
  for (const unit of corpus.units) {
    byOrdinal.set(unit.ordinal, unit);
  }

  const hits: RankedUnit[] = [];
  for (const unit of corpus.units) {
    const lower = unit.text.toLowerCase();
    const matchedTerms: string[] = [];
    let score = 0;
    const tf = corpus.index.tf[unit.id] ?? {};

    for (const term of terms) {
      if (!termMatch(lower, term)) {
        continue;
      }
      matchedTerms.push(term);
      const frequency = tf[term] ?? 1;
      score += frequency * idf(corpus.index, term);
    }

    if (!matchedTerms.length) {
      continue;
    }

    if (unit.structure.isHeading) {
      score *= opts.headingBoost;
    }
    const headerColumns = unit.structure.headerColumns;
    if (headerColumns && headerColumns.length) {
      const lowerHeaders = headerColumns.map((header) => header.toLowerCase());
      if (terms.some((term) => lowerHeaders.some((header) => termMatch(header, term)))) {
        score *= opts.columnHeaderBoost;
      }
    }

    hits.push({ unit, score, matchedTerms, pulledAsNeighbor: false });
  }

  hits.sort((left, right) => right.score - left.score || left.unit.ordinal - right.unit.ordinal);
  const topHits = hits.slice(0, opts.limit);

  // Emit in relevance order: most-relevant hit first, with that hit's pulled
  // neighbors immediately following it (in document order) so surrounding
  // context stays adjacent and readable. Tabular rows are independent, so their
  // neighbors are noise — force radius 0 for row/cell.
  const emitted = new Set<number>();
  const result: RankedUnit[] = [];
  for (const hit of topHits) {
    if (emitted.has(hit.unit.ordinal)) {
      continue;
    }
    emitted.add(hit.unit.ordinal);
    result.push(hit);

    const radius = hit.unit.kind === "row" || hit.unit.kind === "cell" ? 0 : opts.neighborRadius;
    const neighbors: RankedUnit[] = [];
    for (let delta = -radius; delta <= radius; delta += 1) {
      if (delta === 0) {
        continue;
      }
      const neighbor = byOrdinal.get(hit.unit.ordinal + delta);
      if (neighbor && !emitted.has(neighbor.ordinal)) {
        emitted.add(neighbor.ordinal);
        neighbors.push({ unit: neighbor, score: 0, matchedTerms: [], pulledAsNeighbor: true });
      }
    }
    neighbors.sort((left, right) => left.unit.ordinal - right.unit.ordinal);
    result.push(...neighbors);
  }

  return result;
}

/** A pluggable ranker seam so a future embedding ranker can drop in unchanged. */
export interface UnitRanker {
  rank(corpus: FileCorpus, query: string, options?: RankOptions): RankedUnit[] | Promise<RankedUnit[]>;
}

export const lexicalRanker: UnitRanker = {
  rank: (corpus, query, options) => rankUnits(corpus, query, options)
};

/**
 * Clean, human-readable locator the model cites and the user reads. Examples:
 *   - prose, numbered section:  "§9 SQL Injection Testing · line 60"
 *   - prose, named section:     "Pricing › Enterprise · line 42"
 *   - prose, no section:        "line 42"
 *   - spreadsheet:              "Sheet 'Q3' · row 14"
 *   - pdf:                      "page 12"
 */
export function describeUnitLocation(unit: FileUnit): string {
  const { path, sheet, rowIndex, headingPath, sectionNumber, line, page } = unit.address;
  const pathPrefix = path ? `${path}` : "";

  // Tabular: sheet + row is the natural locator.
  if (rowIndex !== undefined) {
    const sheetPart = sheet ? `Sheet '${sheet}' · ` : "";
    const core = `${sheetPart}row ${rowIndex}`;
    return pathPrefix ? `${pathPrefix} › ${core}` : core;
  }

  // Breadcrumb (file path › section hierarchy), joined with " › ".
  const breadcrumb: string[] = [];
  if (pathPrefix) {
    breadcrumb.push(pathPrefix);
  }
  if (headingPath && headingPath.length) {
    // Prefix the deepest section with its number when the doc is numbered.
    const sections = [...headingPath];
    if (sectionNumber) {
      sections[sections.length - 1] = `§${sectionNumber} ${sections[sections.length - 1]}`;
    }
    breadcrumb.push(...sections);
  }

  const parts: string[] = [];
  if (breadcrumb.length) {
    parts.push(breadcrumb.join(" › "));
  }
  if (page !== undefined) {
    parts.push(`page ${page}`);
  }
  if (line !== undefined) {
    parts.push(`line ${line}`);
  }
  return parts.length ? parts.join(" · ") : `unit ${unit.ordinal + 1}`;
}

/**
 * Render ranked units into the compact, self-describing block the model sees.
 * Each unit carries its locator so the model can cite where the answer came
 * from. Bounded to the fat-tool summary budget.
 */
export function formatRankedUnitsForModel(ranked: RankedUnit[]): string {
  if (!ranked.length) {
    return "No matching passages were found in the working file for this query.";
  }

  const lines: string[] = [];
  let used = 0;
  for (const item of ranked) {
    const locator = describeUnitLocation(item.unit);
    const tag = item.pulledAsNeighbor ? " (context)" : "";
    const body = clipWithTruncation(item.unit.text.trim(), PER_UNIT_MAX_CHARS);
    const block = `[${locator}]${tag}\n${body}`;
    if (used + block.length > RENDER_MAX_CHARS) {
      lines.push(`[... ${ranked.length - lines.length} more matching units omitted for length ...]`);
      break;
    }
    lines.push(block);
    used += block.length;
  }

  return lines.join("\n\n");
}
