/**
 * Deterministic retrieval over the web corpus.
 *
 * The user's prompt is the query; we rank every deduped component across a
 * site's mapped pages against the query terms with the SAME TF-IDF nucleus the
 * file corpus uses (rankUnits.ts) — a rare term outweighs a common one. No model
 * in the loop: same query, same ranking. This is the bridge from "we have a
 * corpus" toward "corpus search outputs the plan".
 *
 * It reuses the shared tokenizer/matcher and the CorpusIndex shape rather than
 * the file-corpus ranker itself, because that ranker is coupled to FileUnit and
 * carries prose/tabular boosts that don't apply to interaction components.
 */

import { termMatch, tokenize } from "../shared/textUtils";
import type { CorpusIndex } from "../filecorpus/corpusTypes";
import type { ComponentEntry, WebCorpus } from "./webCorpusTypes";

export type RankedComponent = {
  component: ComponentEntry;
  /** The site the component belongs to. */
  siteId: string;
  /** The page the component was mapped on, so the caller can locate it. */
  pageId: string;
  score: number;
  matchedTerms: string[];
  /** True when this hit came from the site the user is currently on. */
  currentSite: boolean;
};

/**
 * Build the precomputed TF-IDF index over component searchText. Pure; called on
 * write and persisted with the corpus. Mirrors rankUnits.buildIndex, keyed by
 * component id.
 */
export function buildComponentIndex(components: ComponentEntry[]): CorpusIndex {
  const df: Record<string, number> = {};
  const tf: Record<string, Record<string, number>> = {};
  for (const c of components) {
    const counts: Record<string, number> = {};
    for (const token of tokenize(c.searchText)) {
      counts[token] = (counts[token] ?? 0) + 1;
    }
    tf[c.id] = counts;
    for (const token of Object.keys(counts)) {
      df[token] = (df[token] ?? 0) + 1;
    }
  }
  return { n: components.length, df, tf };
}

function idf(index: CorpusIndex, term: string): number {
  return Math.log(1 + index.n / (1 + (index.df[term] ?? 0)));
}

/** All components across a site's pages, paired with their page id. */
function allComponents(corpus: WebCorpus): Array<{ component: ComponentEntry; pageId: string }> {
  const out: Array<{ component: ComponentEntry; pageId: string }> = [];
  for (const page of Object.values(corpus.pages)) {
    for (const component of page.components) {
      out.push({ component, pageId: page.pageId });
    }
  }
  return out;
}

/**
 * Rank a site's components against a query. `query` may be raw prompt text or
 * pre-split terms — tokenized either way. Returns hits in descending score,
 * tie-broken by ordinal for determinism, capped at `limit`.
 */
export function rankComponents(corpus: WebCorpus, query: string | string[], limit = 8): RankedComponent[] {
  const rawTerms = Array.isArray(query) ? query : tokenize(query);
  const terms = Array.from(new Set(rawTerms.flatMap((term) => tokenize(term))));
  if (!terms.length) {
    return [];
  }

  const hits: RankedComponent[] = [];
  for (const { component, pageId } of allComponents(corpus)) {
    const haystack = component.searchText.toLowerCase();
    const tf = corpus.index.tf[component.id] ?? {};
    const matchedTerms: string[] = [];
    let score = 0;
    for (const term of terms) {
      if (!termMatch(haystack, term)) {
        continue;
      }
      matchedTerms.push(term);
      const frequency = tf[term] ?? 1;
      score += frequency * idf(corpus.index, term);
    }
    if (!matchedTerms.length) {
      continue;
    }
    hits.push({ component, siteId: corpus.siteId, pageId, score, matchedTerms, currentSite: false });
  }

  hits.sort((a, b) => b.score - a.score || a.component.ordinal - b.component.ordinal);
  return hits.slice(0, limit);
}

/**
 * Rank across EVERY mapped site, merging current-site first. The rule (per the
 * product principle): current-site hits weigh higher when present; if the
 * current site has none, other sites are first-class; if nothing matches
 * anywhere, the caller falls through to general search. Pure given the corpora,
 * so the only IO cost is the single getAll the caller already paid.
 *
 * Scores from different corpora aren't directly comparable (each has its own
 * idf), so we do NOT interleave by raw score — current-site hits are emitted
 * first (ranked among themselves), then all other-site hits (ranked among
 * themselves). No cap on other sites beyond the per-pool limit.
 */
export function rankAcrossSites(
  corpora: WebCorpus[],
  query: string | string[],
  currentSiteId: string | undefined,
  limitPerPool = 8
): RankedComponent[] {
  const current = corpora.find((c) => c.siteId === currentSiteId);
  const others = corpora.filter((c) => c.siteId !== currentSiteId);

  const currentHits = current
    ? rankComponents(current, query, limitPerPool).map((h) => ({ ...h, currentSite: true }))
    : [];

  const otherHits = others
    .flatMap((c) => rankComponents(c, query, limitPerPool))
    .sort((a, b) => b.score - a.score || a.component.ordinal - b.component.ordinal)
    .slice(0, limitPerPool);

  return [...currentHits, ...otherHits];
}

/**
 * Render ranked components into a compact, model-facing block for the planner.
 * Each line carries the component's behavior, where it lives, and where it leads
 * — drawn from the ACCUMULATED corpus (across all mapped pages of the site), not
 * just the current capture. Returns an empty string when there are no hits, so
 * callers can drop the section cleanly.
 */
export function formatRankedComponentsForPlanner(ranked: RankedComponent[]): string {
  if (!ranked.length) {
    return "";
  }
  const lines = ranked.map((hit) => {
    const c = hit.component;
    const label = c.label ?? (c.name || "(unnamed)");
    const count = c.instanceCount > 1 ? ` ×${c.instanceCount}` : "";
    const dest = c.destination ? ` → ${c.destination.pattern}` : "";
    const desc = c.description ? ` — ${c.description}` : "";
    const origin = hit.currentSite ? "" : " [other site]";
    return `- ${c.kind} "${label}"${count}${dest} (on ${hit.pageId})${origin}${desc}`;
  });
  return ["Relevant interaction targets recalled from your accumulated site map:", ...lines].join("\n");
}
