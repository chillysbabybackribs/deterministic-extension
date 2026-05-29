/**
 * Deterministic retrieval over the web corpus's RESEARCH-CONTENT layer.
 *
 * The interaction layer (rankComponents.ts) answers "what can I click here";
 * this layer answers "what does the content say". The deterministic research
 * loop extracts/cleans/sections pages into ContentSections and writes them to
 * the corpus; this module ranks those sections against the user's prompt with
 * the SAME TF-IDF nucleus and renders the top hits as a STRUCTURED SUMMARY the
 * model synthesizes its final answer from — verbatim text plus source URLs, so
 * the model never reads a raw page.
 *
 * Mirrors rankComponents.ts deliberately (same index shape, same tokenizer/
 * matcher) so the two layers stay consistent and a future embedding ranker drops
 * into both. Kept separate because section prose and interaction labels are
 * different vocabularies — sharing one idf would distort both.
 */

import { termMatch, tokenize } from "../shared/textUtils";
import type { CorpusIndex } from "../filecorpus/corpusTypes";
import type { ContentSection, WebCorpus } from "./webCorpusTypes";

export type RankedSection = {
  section: ContentSection;
  /** The site the section belongs to. */
  siteId: string;
  /** The page the section was extracted on, so the caller can locate it. */
  pageId: string;
  score: number;
  matchedTerms: string[];
  /** True when this hit came from the site the user is currently on. */
  currentSite: boolean;
};

/**
 * Build the precomputed TF-IDF index over section searchText. Pure; called on
 * write and persisted with the corpus as `contentIndex`. Keyed by section id.
 */
export function buildSectionIndex(sections: ContentSection[]): CorpusIndex {
  const df: Record<string, number> = {};
  const tf: Record<string, Record<string, number>> = {};
  for (const s of sections) {
    const counts: Record<string, number> = {};
    for (const token of tokenize(s.searchText)) {
      counts[token] = (counts[token] ?? 0) + 1;
    }
    tf[s.id] = counts;
    for (const token of Object.keys(counts)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }
  return { n: sections.length, df, tf };
}

function idf(index: CorpusIndex, term: string): number {
  return Math.log(1 + index.n / (1 + (index.df[term] ?? 0)));
}

/** All sections across a site's pages, paired with their page id. */
function allSections(corpus: WebCorpus): Array<{ section: ContentSection; pageId: string }> {
  const out: Array<{ section: ContentSection; pageId: string }> = [];
  for (const page of Object.values(corpus.pages)) {
    for (const section of page.contentSections ?? []) {
      out.push({ section, pageId: page.pageId });
    }
  }
  return out;
}

/**
 * Rank a site's content sections against a query. `query` may be raw prompt text
 * or pre-split terms — tokenized either way. Returns hits in descending score,
 * tie-broken by ordinal for determinism, capped at `limit`.
 */
export function rankSections(corpus: WebCorpus, query: string | string[], limit = 8): RankedSection[] {
  const rawTerms = Array.isArray(query) ? query : tokenize(query);
  const terms = Array.from(new Set(rawTerms.flatMap((term) => tokenize(term))));
  if (!terms.length) {
    return [];
  }

  const hits: RankedSection[] = [];
  for (const { section, pageId } of allSections(corpus)) {
    const haystack = section.searchText.toLowerCase();
    const tf = corpus.contentIndex.tf[section.id] ?? {};
    const matchedTerms: string[] = [];
    let score = 0;
    for (const term of terms) {
      if (!termMatch(haystack, term)) {
        continue;
      }
      matchedTerms.push(term);
      const frequency = tf[term] ?? 1;
      score += frequency * idf(corpus.contentIndex, term);
    }
    if (!matchedTerms.length) {
      continue;
    }
    hits.push({ section, siteId: corpus.siteId, pageId, score, matchedTerms, currentSite: false });
  }

  hits.sort((a, b) => b.score - a.score || a.section.ordinal - b.section.ordinal);
  return hits.slice(0, limit);
}

/**
 * Rank content sections across EVERY mapped site. Same merge rule as
 * rankComponents.rankAcrossSites: current-site hits first (ranked among
 * themselves), then all other-site hits (ranked among themselves). Scores from
 * different corpora aren't directly comparable (separate idf), so we do not
 * interleave by raw score.
 */
export function rankSectionsAcrossSites(
  corpora: WebCorpus[],
  query: string | string[],
  currentSiteId: string | undefined,
  limitPerPool = 8
): RankedSection[] {
  const current = corpora.find((c) => c.siteId === currentSiteId);
  const others = corpora.filter((c) => c.siteId !== currentSiteId);

  const currentHits = current
    ? rankSections(current, query, limitPerPool).map((h) => ({ ...h, currentSite: true }))
    : [];

  const otherHits = others
    .flatMap((c) => rankSections(c, query, limitPerPool))
    .sort((a, b) => b.score - a.score || a.section.ordinal - b.section.ordinal)
    .slice(0, limitPerPool);

  return [...currentHits, ...otherHits];
}

/**
 * Render ranked sections as the STRUCTURED SUMMARY the model synthesizes from.
 * Each block carries the section title, its verbatim text, and the source URL(s)
 * so the model can cite them — the model never sees the raw page, only this.
 * Returns an empty string when there are no hits so the caller can fall through
 * to a live research pass cleanly. `maxChars` bounds total size for the prompt.
 */
export function formatSectionsAsStructuredSummary(ranked: RankedSection[], maxChars = 8000): string {
  if (!ranked.length) {
    return "";
  }
  const blocks: string[] = [];
  let used = 0;
  for (const hit of ranked) {
    const s = hit.section;
    const sources = s.sourceUrls.length ? s.sourceUrls.join(", ") : hit.pageId;
    const block = [`### ${s.title || "(untitled section)"}`, `Source: ${sources}`, "", s.text].join("\n");
    if (used + block.length > maxChars && blocks.length) {
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return ["Structured findings recalled from your accumulated research corpus:", "", ...blocks].join("\n\n");
}
