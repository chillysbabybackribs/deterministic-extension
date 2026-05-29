/**
 * The deterministic research loop (Slice 3).
 *
 *   search (background, current tab)  →  open each result ONE AT A TIME in the
 *   single working tab  →  extract → strip → clean → label (extractContentSections)
 *   →  accumulate + dedupe sections ACROSS pages  →  write to the web corpus.
 *
 * No model in the loop. The model planned the searches (upstream) and will
 * synthesize from the corpus afterwards (downstream); this stage just does the
 * deterministic gathering that fills the research-content layer.
 *
 * PIPELINED PRE-WARM: a single tab can't hold two pages at once, so we overlap
 * WORK, not pages — capture page N's snapshot, then kick off navigation to N+1
 * while extractContentSections(N) (pure CPU) runs against the snapshot already in
 * hand. The next page's network load thus overlaps the current page's
 * processing, keeping the one working tab busy instead of idle.
 *
 * Browser IO is injected as `fetchPage` so the orchestration is unit-testable
 * without a real tab; the production fetcher lives in researchLoopFetcher.ts.
 */

import { extractContentSections } from "../../webcorpus/extractContentSections";
import { toPageId, toSiteId } from "../../webcorpus/ingestPage";
import { writePage } from "../../webcorpus/webCorpusStore";
import type { ContentSection, PageEntry } from "../../webcorpus/webCorpusTypes";
import type { PageSnapshot } from "../../tools/snapshot/pageSnapshotTypes";

/** A page the loop fetched, snapshot + the URL it was opened at. */
export type FetchedPage = {
  url: string;
  snapshot: PageSnapshot;
  warnings: string[];
};

/** Injected browser IO: navigate the working tab to `url` and snapshot it. */
export type FetchPage = (url: string) => Promise<FetchedPage | undefined>;

export type ResearchLoopResult = {
  /** URLs the loop actually opened and extracted (in order). */
  visitedUrls: string[];
  /** Sections written, deduped across all pages this run. */
  sections: ContentSection[];
  /** Pages written to the corpus, one per distinct pageId. */
  pagesWritten: number;
  warnings: string[];
};

export type RunResearchLoopArgs = {
  /** Candidate result URLs to open, in priority order. */
  urls: string[];
  /** Injected page fetcher (navigate + snapshot). */
  fetchPage: FetchPage;
  /** ISO timestamp stamped on captured sections/pages. */
  now: string;
  /** Max pages to open this run (bounds tab churn + tokens). */
  maxPages?: number;
  /** Optional progress hook for the activity log. */
  onProgress?: (message: string) => void;
  /** Optional abort check between pages. */
  shouldStop?: () => boolean;
};

const DEFAULT_MAX_PAGES = 5;

/**
 * Open each URL one at a time in the working tab, extract content sections, and
 * write them to the corpus — pipelining the next page's load over the current
 * page's extraction. Pure orchestration over the injected fetcher.
 */
export async function runResearchLoop(args: RunResearchLoopArgs): Promise<ResearchLoopResult> {
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES;
  const urls = dedupeUrls(args.urls).slice(0, maxPages);
  const warnings: string[] = [];
  const visitedUrls: string[] = [];

  // Sections accumulated across ALL pages this run, deduped by contentKey so the
  // same passage corroborated on two result pages collapses (sourceUrls merged).
  const sectionsByKey = new Map<string, ContentSection>();
  // Per page (by pageId) we keep that page's own deduped sections, so each
  // PageEntry written to the corpus carries the sections that belong to it.
  const pageSections = new Map<string, { siteId: string; siteName: string; pageId: string; url: string; title: string; sections: ContentSection[] }>();

  // Pipelined pre-warm: hold the in-flight fetch for the NEXT url so it loads
  // while we process the CURRENT page. Primed with the first url.
  let nextFetch: Promise<FetchedPage | undefined> | undefined =
    urls.length ? args.fetchPage(urls[0]) : undefined;

  for (let i = 0; i < urls.length; i += 1) {
    if (args.shouldStop?.()) {
      warnings.push("Research loop stopped early.");
      break;
    }
    const url = urls[i];
    args.onProgress?.(`Reading result ${i + 1}/${urls.length}: ${url}`);

    const fetched = await nextFetch;
    // Kick off the NEXT page's navigation now, BEFORE extracting this one, so the
    // next page's network load overlaps this page's (CPU-bound) extraction.
    nextFetch = i + 1 < urls.length ? args.fetchPage(urls[i + 1]) : undefined;

    if (!fetched) {
      warnings.push(`Could not open ${url}.`);
      continue;
    }
    warnings.push(...fetched.warnings);
    visitedUrls.push(fetched.url);

    const site = toSiteId(fetched.url);
    const pageId = toPageId(fetched.url);
    if (!site || !pageId) {
      warnings.push(`Skipped a result with an unusable URL: ${fetched.url}`);
      continue;
    }

    const extracted = extractContentSections(fetched.snapshot, args.now);
    if (!extracted.length) {
      warnings.push(`No high-value content extracted from ${fetched.url}.`);
      continue;
    }

    // Cross-page dedup: a section already seen elsewhere this run merges its
    // source URL instead of duplicating. The page that FIRST contributed a
    // section owns it for its PageEntry.
    const owned: ContentSection[] = [];
    for (const section of extracted) {
      const prior = sectionsByKey.get(section.contentKey);
      if (prior) {
        if (!prior.sourceUrls.includes(fetched.url)) {
          prior.sourceUrls.push(fetched.url);
        }
        continue;
      }
      sectionsByKey.set(section.contentKey, section);
      owned.push(section);
    }

    const bucket = pageSections.get(pageId);
    if (bucket) {
      bucket.sections.push(...owned);
    } else {
      pageSections.set(pageId, {
        siteId: site.siteId,
        siteName: site.siteName,
        pageId,
        url: fetched.url,
        title: fetched.snapshot.title || pageId,
        sections: owned
      });
    }
  }

  // Persist one PageEntry per researched page (only pages that contributed
  // sections). The interaction layer is empty for research pages.
  let pagesWritten = 0;
  for (const entry of pageSections.values()) {
    if (!entry.sections.length) {
      continue;
    }
    const page: PageEntry = {
      pageId: entry.pageId,
      title: entry.title,
      lastUrl: entry.url,
      capturedAt: args.now,
      visitCount: 0,
      components: [],
      contentSections: entry.sections,
      rawElementCount: 0,
      dedupedCount: 0,
      warnings: []
    };
    try {
      await writePage({ siteId: entry.siteId, siteName: entry.siteName, page, now: args.now });
      pagesWritten += 1;
    } catch (error) {
      warnings.push(`Could not persist ${entry.pageId}: ${error instanceof Error ? error.message : "write failed"}`);
    }
  }

  return {
    visitedUrls,
    sections: Array.from(sectionsByKey.values()),
    pagesWritten,
    warnings: uniq(warnings)
  };
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = url.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
