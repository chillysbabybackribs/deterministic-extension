/**
 * Types for the persistent "web interaction corpus".
 *
 * Unlike the per-pass element corpus (src/tools/elementCorpus.ts), which is built
 * from one overlay capture and thrown away, the WebCorpus ACCUMULATES across
 * visits: every navigation to a new page folds that page's mapped interaction
 * surface into a durable, per-origin corpus that is searchable by natural
 * language. The sum of a user's visits becomes an "always up to date" map of the
 * sites they use — and as that map gets rich enough, planning a task becomes a
 * RETRIEVAL over this corpus rather than a generation by the model.
 *
 * Three nested levels, matching how the idea was described:
 *   WebCorpus (one per origin)        — accumulates over time
 *     └─ PageEntry (one per route)    — the map of a single visited page
 *          └─ ComponentEntry          — a BEHAVIORALLY-DEDUPED interaction unit
 *
 * Two requirements are first-class here, even though their population logic is a
 * later slice — the slots exist now so we never have to migrate:
 *   1. BEHAVIORAL DEDUP — 50 identical "Add to cart" buttons collapse to ONE
 *      ComponentEntry (same `behaviorKey`) carrying an `instanceCount`. This is
 *      what keeps "map a whole web app" tractable.
 *   2. REGIONAL SEGMENTATION — each component is tagged with the page `region`
 *      it lives in (header / sidebar / results / ...), not a flat document-order
 *      list.
 *
 * Design alignment:
 *   - Mirrors src/filecorpus/corpusTypes.ts: per-source keying (fileId → pageId),
 *     a precomputed retrieval index, and a compact descriptor that travels to the
 *     model while the corpus stays in IndexedDB. The same store/ranker patterns
 *     drop in.
 *   - Leaf module: imports ONLY the capture/index shapes it reuses; nothing from
 *     the pipeline or UI, so it never participates in an import cycle.
 *   - Local-only for now (no server/sync fields), but `siteId`/`pageId` are plain
 *     serializable strings so a sync layer can be added later WITHOUT a schema
 *     change. (Local-vs-shared was explicitly deferred.)
 */

import type { CorpusIndex } from "../filecorpus/corpusTypes";
import type { ActionableLinkInfo } from "../tools/elementOverlay";

// --- Keys ---------------------------------------------------------------------

/**
 * Origin of a site, normalized (scheme + host, lowercased, no trailing slash):
 * e.g. "https://www.amazon.com". The accumulation unit — one WebCorpus per site.
 */
export type SiteId = string;

/**
 * A single visited route within a site, normalized: origin + pathname, with the
 * query string and hash stripped by default (they explode the corpus and break
 * "always up to date" — the SAME logical page should map to the SAME entry on a
 * repeat visit). e.g. "https://www.amazon.com/gp/cart". Normalization rules live
 * with the ingest slice, not here.
 */
export type PageId = string;

// --- Regions ------------------------------------------------------------------

/**
 * Coarse page region a component lives in. Populated by a later segmentation
 * slice (spatial clustering + landmark roles); until then components are tagged
 * "unknown". Deliberately small and stable — refinements layer on top.
 */
export type PageRegion =
  | "header"
  | "nav"
  | "sidebar"
  | "main"
  | "results"
  | "footer"
  | "modal"
  | "unknown";

// --- Component (behaviorally-deduped interaction unit) ------------------------

/** What kind of interaction a component affords. Coarse; derived from role/tag. */
export type ComponentKind =
  | "link"
  | "button"
  | "input"
  | "select"
  | "textarea"
  | "checkbox"
  | "radio"
  | "tab"
  | "menuitem"
  | "other";

/**
 * The destination a component leads to, NORMALIZED for dedup. A grid of 50
 * "Add to cart" buttons each link to a product-specific URL, but they share a
 * destination PATTERN (e.g. "/cart/add/:id") and a behavior — so they collapse
 * to one ComponentEntry. We keep the pattern (for grouping) plus a couple of
 * concrete examples (for display / debugging), never all N.
 */
export type ComponentDestination = {
  /** Normalized destination pattern used as part of the dedup key (ids → :id). */
  pattern: string;
  /** Coarse kind, carried over from overlay link enrichment. */
  kind: ActionableLinkInfo["kind"];
  /** Relationship to the page origin, carried over from overlay enrichment. */
  rel?: ActionableLinkInfo["rel"];
  /** A few concrete destination paths observed for this pattern (bounded). */
  examples: string[];
};

/**
 * One behaviorally-distinct interaction on a page. Multiple raw DOM elements that
 * share a `behaviorKey` are represented by a SINGLE ComponentEntry.
 */
export type ComponentEntry = {
  /** Stable within a page: `${pageId}#c${ordinal}`. */
  id: string;
  /** Document-order ordinal of the first instance. Deterministic tie-breaking. */
  ordinal: number;

  /**
   * The dedup identity: a stable key derived from (kind + normalized name +
   * destination pattern + region). Two elements with the same behaviorKey are the
   * SAME component. Computed by the ingest slice; the rule lives there, not here.
   */
  behaviorKey: string;
  /** How many raw DOM elements collapsed into this one entry (>= 1). */
  instanceCount: number;

  kind: ComponentKind;
  region: PageRegion;

  /** Normalized accessible name (lowercased, punctuation→space, collapsed). */
  name: string;
  /** Original (un-normalized) accessible name, for display. */
  label?: string;

  /**
   * Human-readable "what this does" summary. EMPTY from deterministic capture;
   * filled by a later, one-time, cheap enrichment call and then cached forever.
   * This optional field is where the "model shrinks out of planning" thesis
   * lives — a rich description makes retrieval-as-planning possible.
   */
  description?: string;

  /** Where it leads, if it links somewhere. Absent for non-navigating controls. */
  destination?: ComponentDestination;

  /**
   * The text indexed for natural-language retrieval (name + label + description +
   * destination words). Precomputed so ranking is O(query terms). Kept separate
   * from `name` so we control exactly what feeds the index.
   */
  searchText: string;
};

// --- Page entry ---------------------------------------------------------------

/** Map of one visited page: its behavior-deduped components + freshness. */
export type PageEntry = {
  pageId: PageId;
  /** The page's document title at capture time, for display. */
  title: string;
  /** The concrete URL last captured (full, including query) — for reference. */
  lastUrl: string;

  /** ISO timestamp of the most recent capture that refreshed this page. */
  capturedAt: string;
  /** How many times this page has been (re)captured — accumulation signal. */
  visitCount: number;

  components: ComponentEntry[];

  /** Raw actionable count before behavioral dedup (provenance for tuning). */
  rawElementCount: number;
  /** Count collapsed away by behavioral dedup. */
  dedupedCount: number;
  /** Non-fatal notes from ingest (e.g. region inference low-confidence). */
  warnings: string[];
};

// --- Site corpus (the persisted, accumulating unit) ---------------------------

export type WebCorpus = {
  siteId: SiteId;
  /** Human label: the site host (e.g. "www.amazon.com"). */
  siteName: string;

  /** ISO timestamp of the first page ever mapped for this site. */
  createdAt: string;
  /** ISO timestamp of the most recent page capture folded in. */
  updatedAt: string;

  /** Visited pages, keyed by PageId for O(1) refresh on re-visit. */
  pages: Record<PageId, PageEntry>;
  /** Convenience: number of distinct pages mapped. */
  pageCount: number;
  /** Convenience: total behavior-deduped components across all pages. */
  componentCount: number;

  /**
   * Precomputed retrieval index over component `searchText`, reusing the
   * filecorpus TF-IDF shape so the existing UnitRanker seam (and a future
   * embedding ranker) drops in unchanged. Rebuilt incrementally as pages fold in.
   */
  index: CorpusIndex;

  /** Non-fatal accumulation notes (e.g. page cap reached). */
  warnings: string[];
};

// --- Compact descriptor (what travels to the model, not the corpus itself) ----

/**
 * Self-describing summary of a site's corpus for model prompts / UI status. The
 * full WebCorpus stays in IndexedDB and is queried lazily; this is the cheap
 * "what do I know about this site" handle. Mirrors ActiveWorkingFileDescriptor.
 */
export type WebCorpusPageSummary = {
  /** Normalized page key (origin + path, no query/hash). */
  pageId: PageId;
  /** Full URL last captured for this page (includes query/hash). */
  lastUrl: string;
  title: string;
  componentCount: number;
  visitCount: number;
  /** ISO timestamp of the most recent capture of this page. */
  capturedAt: string;
};

export type WebCorpusDescriptor = {
  siteName: string;
  pageCount: number;
  componentCount: number;
  /** ISO timestamp of the last update — drives an "Updated Nm ago" tooltip. */
  updatedAt: string;
  /** Per-page detail, newest capture first. Present in the UI readout. */
  pages?: WebCorpusPageSummary[];
};

/** Natural-language phrase describing what's mapped for a site, for prompts. */
export function describeWebCorpus(d: WebCorpusDescriptor): string {
  return `a map of "${d.siteName}" (${d.pageCount} page${
    d.pageCount === 1 ? "" : "s"
  }, ${d.componentCount} components)`;
}
