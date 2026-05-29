/**
 * Per-tab site-recon cache + lifecycle (auto-run once per page load).
 *
 * When a tab finishes loading a normal http(s) page, we run the site recon
 * (in-page link harvest + robots/sitemap) ONCE for that origin and cache it,
 * keyed by tabId. A prompt later finds the inventory already built — no per-turn
 * wait. The cache is invalidated when the tab's ORIGIN changes, when the tab is
 * removed/replaced, and is bounded so a long browsing session can't leak.
 *
 * Lifecycle/IO (chrome.tabs, executeScript, fetch) is INJECTED so this is unit
 * testable without a browser. serviceWorker.ts wires the real implementations.
 */

import type { SiteRecon } from "../tools/siteRecon";

export type ReconCacheEntry = {
  tabId: number;
  origin: string;
  recon: SiteRecon;
  builtAtMs: number;
};

export type ReconRunner = (tabId: number, origin: string) => Promise<SiteRecon | undefined>;

/** Time provider — injected so tests are deterministic (no Date.now in scripts). */
export type NowFn = () => number;

const MAX_TABS = 50;
const STALE_MS = 10 * 60_000; // re-run if a cached origin is older than 10 min.

export class ReconCache {
  private readonly byTab = new Map<number, ReconCacheEntry>();
  /** Tabs with a recon currently in flight, to dedupe concurrent triggers. */
  private readonly inFlight = new Set<number>();

  constructor(private readonly runner: ReconRunner, private readonly now: NowFn) {}

  get(tabId: number): ReconCacheEntry | undefined {
    return this.byTab.get(tabId);
  }

  /** Compute the origin of a URL, or undefined for non-http(s)/invalid. */
  static originOf(url: string | undefined): string | undefined {
    if (!url || !/^https?:/i.test(url)) {
      return undefined;
    }
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * Trigger a recon for a tab that finished loading `url`. No-op when the URL is
   * unsupported, when this exact origin is already cached and fresh, or when a
   * run is already in flight for the tab. Returns the entry (cached or new), or
   * undefined when nothing was/could be built.
   */
  async maybeRun(tabId: number, url: string | undefined): Promise<ReconCacheEntry | undefined> {
    const origin = ReconCache.originOf(url);
    if (!origin) {
      // Navigated to a non-web page — drop any stale entry for this tab.
      this.byTab.delete(tabId);
      return undefined;
    }

    const existing = this.byTab.get(tabId);
    if (existing && existing.origin === origin && this.now() - existing.builtAtMs < STALE_MS) {
      return existing; // same origin, still fresh — reuse.
    }
    if (this.inFlight.has(tabId)) {
      return existing;
    }

    this.inFlight.add(tabId);
    try {
      const recon = await this.runner(tabId, origin);
      if (!recon) {
        return existing;
      }
      const entry: ReconCacheEntry = { tabId, origin, recon, builtAtMs: this.now() };
      this.byTab.set(tabId, entry);
      this.evictIfNeeded();
      return entry;
    } finally {
      this.inFlight.delete(tabId);
    }
  }

  clearTab(tabId: number): void {
    this.byTab.delete(tabId);
  }

  size(): number {
    return this.byTab.size;
  }

  /** Bound the cache: drop the oldest entries beyond MAX_TABS. */
  private evictIfNeeded(): void {
    if (this.byTab.size <= MAX_TABS) {
      return;
    }
    const entries = [...this.byTab.values()].sort((a, b) => a.builtAtMs - b.builtAtMs);
    const toDrop = entries.slice(0, this.byTab.size - MAX_TABS);
    for (const e of toDrop) {
      this.byTab.delete(e.tabId);
    }
  }
}

// --- Singleton wiring (shared by the service worker + the interaction pipeline) -
// The service worker installs the real runner via initReconCache(); both it and
// pipelineRunner read cached recons via getCachedSiteRecon() — no import cycle.

let singleton: ReconCache | undefined;

export function initReconCache(runner: ReconRunner, now: NowFn): ReconCache {
  singleton = new ReconCache(runner, now);
  return singleton;
}

export function getCachedSiteRecon(tabId: number): SiteRecon | undefined {
  return singleton?.get(tabId)?.recon;
}
