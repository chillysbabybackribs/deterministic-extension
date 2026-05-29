/**
 * Persistence for the accumulating web-interaction corpus, in IndexedDB.
 * Mirrors src/filecorpus/corpusStore.ts (open/upgrade, idbRequest, migrate-on-read)
 * but is keyed by SiteId and ACCUMULATES: a page write folds one PageEntry into
 * the site's existing corpus instead of replacing it.
 *
 * Runs wherever it's imported; in this build that is the MV3 service worker
 * (IndexedDB is available there), co-located with the overlay capture so writing
 * a page on navigation needs no round-trip to the panel.
 *
 * One store:
 *  - `sites` (keyPath "siteId") holds full WebCorpus records.
 *
 * This slice intentionally does NOT build the retrieval index or dedup — it
 * proves capture survives and accumulates. `index` is left empty and
 * `componentCount` reflects the flat per-page component count.
 */

import { buildComponentIndex } from "./rankComponents";
import type { PageEntry, WebCorpus, WebCorpusDescriptor, WebCorpusPageSummary } from "./webCorpusTypes";

const DB_NAME = "ohmygod.webcorpus";
const DB_VERSION = 1;
const SITE_STORE = "sites";
const SCHEMA_VERSION = 1;

/** Cap pages per site so an accidental crawl can't balloon a record unbounded. */
const MAX_PAGES_PER_SITE = 200;

type StoredCorpus = WebCorpus & { schemaVersion: number };

function isSupported(): boolean {
  return "indexedDB" in globalThis;
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(SITE_STORE)) {
      db.createObjectStore(SITE_STORE, { keyPath: "siteId" });
    }
  };
  return idbRequest(request);
}

function migrate(record: StoredCorpus): StoredCorpus {
  // No migrations yet; stamp the current schema version for forward records.
  return record.schemaVersion === SCHEMA_VERSION ? record : { ...record, schemaVersion: SCHEMA_VERSION };
}

export async function getWebCorpus(siteId: string): Promise<WebCorpus | undefined> {
  if (!isSupported()) {
    return undefined;
  }
  const db = await openDb();
  const record = await idbRequest<StoredCorpus | undefined>(
    db.transaction(SITE_STORE, "readonly").objectStore(SITE_STORE).get(siteId)
  );
  db.close();
  return record ? migrate(record) : undefined;
}

async function putWebCorpus(corpus: WebCorpus): Promise<void> {
  if (!isSupported()) {
    throw new Error("This browser does not support storing a web corpus.");
  }
  const record: StoredCorpus = { ...corpus, schemaVersion: SCHEMA_VERSION };
  const db = await openDb();
  await idbRequest(db.transaction(SITE_STORE, "readwrite").objectStore(SITE_STORE).put(record));
  db.close();
}

/** Empty corpus for a site not seen before. `now` is an ISO timestamp. */
function emptyCorpus(siteId: string, siteName: string, now: string): WebCorpus {
  return {
    siteId,
    siteName,
    createdAt: now,
    updatedAt: now,
    pages: {},
    pageCount: 0,
    componentCount: 0,
    index: { n: 0, df: {}, tf: {} },
    warnings: []
  };
}

/**
 * Fold one captured page into a site's corpus and persist. Creates the site's
 * corpus on first write; on a revisit it REPLACES that page's entry (newest
 * capture wins) while carrying the visit count forward. Pure accumulation — no
 * dedup/index work in this slice.
 *
 * Returns the descriptor of the resulting corpus (for UI/logging).
 */
export async function writePage(args: {
  siteId: string;
  siteName: string;
  page: PageEntry;
  now: string;
}): Promise<WebCorpusDescriptor> {
  const existing = (await getWebCorpus(args.siteId)) ?? emptyCorpus(args.siteId, args.siteName, args.now);

  const prior = existing.pages[args.page.pageId];
  const visitCount = (prior?.visitCount ?? 0) + 1;
  const page: PageEntry = { ...args.page, visitCount, capturedAt: args.now };

  const pages = { ...existing.pages, [args.page.pageId]: page };

  const warnings = [...existing.warnings];
  let prunedPages = pages;
  if (Object.keys(pages).length > MAX_PAGES_PER_SITE) {
    // Evict least-recently-captured pages to stay under the cap. Keeps the most
    // recently useful map; a coarse backstop, not a real LRU policy yet.
    const sorted = Object.values(pages).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    prunedPages = Object.fromEntries(sorted.slice(0, MAX_PAGES_PER_SITE).map((p) => [p.pageId, p]));
    if (!warnings.includes("page-cap-reached")) {
      warnings.push("page-cap-reached");
    }
  }

  const pageList = Object.values(prunedPages);
  const allComponents = pageList.flatMap((p) => p.components);
  const next: WebCorpus = {
    ...existing,
    siteName: args.siteName || existing.siteName,
    updatedAt: args.now,
    pages: prunedPages,
    pageCount: pageList.length,
    componentCount: allComponents.length,
    // Full rebuild over all pages' components. Component ids are stable per page,
    // so a rebuild is simplest and keeps the site-wide index exactly consistent
    // with what rankComponents scores. Cheap at these sizes (deduped components).
    index: buildComponentIndex(allComponents),
    warnings
  };

  await putWebCorpus(next);
  return descriptorFromCorpus(next);
}

/** Every persisted site corpus, full records. One read; ranking happens in memory. */
export async function getAllWebCorpora(): Promise<WebCorpus[]> {
  if (!isSupported()) {
    return [];
  }
  const db = await openDb();
  const records = await idbRequest<StoredCorpus[]>(
    db.transaction(SITE_STORE, "readonly").objectStore(SITE_STORE).getAll()
  );
  db.close();
  return records.map(migrate);
}

/** All persisted site corpora, as compact descriptors. For the UI readout. */
export async function listWebCorpusDescriptors(): Promise<WebCorpusDescriptor[]> {
  if (!isSupported()) {
    return [];
  }
  const db = await openDb();
  const records = await idbRequest<StoredCorpus[]>(
    db.transaction(SITE_STORE, "readonly").objectStore(SITE_STORE).getAll()
  );
  db.close();
  return records
    .map((corpus) => ({ ...descriptorFromCorpus(corpus), pages: pageSummaries(corpus) }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function pageSummaries(corpus: WebCorpus): WebCorpusPageSummary[] {
  return Object.values(corpus.pages)
    .map((p) => ({
      pageId: p.pageId,
      lastUrl: p.lastUrl,
      title: p.title,
      componentCount: p.components.length,
      visitCount: p.visitCount,
      capturedAt: p.capturedAt
    }))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** Lean descriptor (no per-page detail) for model prompts / status. */
export function descriptorFromCorpus(corpus: WebCorpus): WebCorpusDescriptor {
  return {
    siteName: corpus.siteName,
    pageCount: corpus.pageCount,
    componentCount: corpus.componentCount,
    updatedAt: corpus.updatedAt
  };
}
