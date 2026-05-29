/**
 * The web-research path (Slice 4 wiring).
 *
 * Implements the flow:
 *   model builds the search loop  →  deterministic loop builds the corpus
 *   (search → open results one at a time in the working tab → extract/clean/
 *   section/dedupe → write)  →  deterministic corpus search returns a STRUCTURED
 *   SUMMARY  →  the model synthesizes from that summary.
 *
 * The model touches a research turn at exactly two points: planning the searches
 * (upstream of here) and final synthesis (downstream of here). It never sees a
 * raw page — only the structured summary this returns. Per the design principle
 * "if a second pass is needed, the search pipeline is broken", there is NO
 * mid-loop model gate: plan → loop → corpus search → done.
 *
 * Self-contained and dependency-injected (search + loop) so it is unit-testable
 * without a browser; pipelineRunner supplies the production implementations.
 */

import { runSearchWeb } from "../../tools/fat";
import { isRecord } from "../../tools/fat/fatToolTypes";
import { runResearchLoop, type FetchPage } from "./researchLoop";
import { getAllWebCorpora } from "../../webcorpus/webCorpusStore";
import { rankSectionsAcrossSites, formatSectionsAsStructuredSummary } from "../../webcorpus/rankSections";
import { toSiteId } from "../../webcorpus/ingestPage";

export type ResearchPathResult = {
  /** Structured summary the model synthesizes from (empty if nothing gathered). */
  structuredSummary: string;
  /** What is still missing, when the corpus search came up empty. */
  missing: string;
  /** URLs the loop actually read. */
  visitedUrls: string[];
  /** Sections recalled from the corpus for this query. */
  recalledCount: number;
  warnings: string[];
};

export type RunResearchPathArgs = {
  /** The intent being researched (the user's prompt or a resolved follow-up). */
  query: string;
  /** Search queries the planner chose (the "search loop" the model built). */
  searchQueries: string[];
  /** URL of the tab the user was on, so corpus recall weighs the current site. */
  currentUrl?: string;
  /**
   * The tab to run the WHOLE pipeline in (the user's current tab). The SERP and
   * every result page navigate this one tab — no new tabs are opened.
   */
  workingTabId?: number;
  now: string;
  maxPages?: number;
  /** Injected browser fetcher for the loop (production: fetchResearchPage). */
  fetchPage: FetchPage;
  /** Injected search runner (defaults to the real search_web fat tool). */
  search?: (query: string) => Promise<string[]>;
  onProgress?: (message: string) => void;
  shouldStop?: () => boolean;
};

/** Run the deterministic research path end to end and return a structured summary. */
export async function runResearchPath(args: RunResearchPathArgs): Promise<ResearchPathResult> {
  const warnings: string[] = [];
  const search = args.search ?? ((query: string) => defaultSearch(query, args.workingTabId));

  // 1) Run the planned searches and collect candidate result URLs (deduped,
  // preserving the planner's query order). Bounded downstream by maxPages.
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const query of args.searchQueries.length ? args.searchQueries : [args.query]) {
    if (args.shouldStop?.()) {
      break;
    }
    args.onProgress?.(`Searching: ${query}`);
    try {
      for (const url of await search(query)) {
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
    } catch (error) {
      warnings.push(`Search failed for "${query}": ${error instanceof Error ? error.message : "error"}`);
    }
  }

  if (!urls.length) {
    return { structuredSummary: "", missing: "No web results could be found for this query.", visitedUrls: [], recalledCount: 0, warnings };
  }

  // 2) Deterministic loop: open results one at a time, extract/clean/section,
  // dedupe across pages, write to the corpus.
  const loop = await runResearchLoop({
    urls,
    fetchPage: args.fetchPage,
    now: args.now,
    maxPages: args.maxPages,
    onProgress: args.onProgress,
    shouldStop: args.shouldStop
  });
  warnings.push(...loop.warnings);

  // 3) Deterministic corpus search → structured summary for synthesis. Rank the
  // research-content layer across all sites, current site weighted first.
  const corpora = await getAllWebCorpora();
  const currentSiteId = args.currentUrl ? toSiteId(args.currentUrl)?.siteId : undefined;
  const ranked = rankSectionsAcrossSites(corpora, args.query, currentSiteId);
  const structuredSummary = formatSectionsAsStructuredSummary(ranked);

  return {
    structuredSummary,
    missing: structuredSummary ? "" : "The gathered pages did not yield content matching the question.",
    visitedUrls: loop.visitedUrls,
    recalledCount: ranked.length,
    warnings
  };
}

/** Production search: run the search_web fat tool and return candidate URLs. */
async function defaultSearch(query: string, tabId?: number): Promise<string[]> {
  const result = await runSearchWeb(tabId !== undefined ? { query, tabId } : { query });
  const extraction = isRecord(result.fullExtraction) ? result.fullExtraction : {};
  const candidates = Array.isArray(extraction.candidates) ? extraction.candidates : [];
  return candidates
    .map((candidate) => (isRecord(candidate) && typeof candidate.url === "string" ? candidate.url : ""))
    .filter(Boolean);
}
