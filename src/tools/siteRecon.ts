/**
 * Initial site reconnaissance (v1 — lean, high-value, free sources only).
 *
 * Gathers the structural information a site openly publishes about itself, so the
 * interaction loop/model know what exists before the user decides. v1 sources:
 *
 *   1. IN-PAGE HARVEST (zero new requests): same-origin <a href>, <link href>,
 *      form actions read from the live DOM → a path tree. Plus any endpoints
 *      already observed by the network-capture buffer, folded in by the caller.
 *   2. robots.txt + sitemap(s): the author's own declared URL inventory.
 *
 * Mapping is discovery, not intrusion: it records what is reachable (including
 * /admin login pages, APIs, etc.) and what each thing is. It is GET-only and
 * read-only — it never submits credentials, never tries to get PAST a login, and
 * never sends mutating requests. Acting on what is found is the loop's job and is
 * governed by the user's own session, not by this module.
 *
 * Deferred (clean seams, NOT built v1): conventional path probing
 * (/admin,/api,/openapi.json…) and API-descriptor parsing (OpenAPI/GraphQL).
 * Both bolt on after the cheap sources prove out.
 */

// --- Types --------------------------------------------------------------------

export type ReconPath = {
  /** Absolute URL. */
  url: string;
  /** Pathname (+ search) for compact display/grep. */
  path: string;
  /** Where we learned about it. */
  source: "link" | "form" | "sitemap" | "robots" | "endpoint";
};

export type SiteRecon = {
  origin: string;
  /** Deduped same-origin paths discovered, sorted by path. */
  paths: ReconPath[];
  /** robots.txt findings (empty when absent/unreachable). */
  robots: {
    fetched: boolean;
    sitemaps: string[];
    /** Disallow/Allow path prefixes (informational — NOT obeyed as a blocker). */
    disallow: string[];
    allow: string[];
  };
  /** Count of sitemap URLs folded into paths. */
  sitemapUrlCount: number;
  warnings: string[];
};

// --- In-page harvest (pure over a snapshot) -----------------------------------

export type HarvestInput = {
  /** location.origin of the page. */
  origin: string;
  /** Raw hrefs from <a> and <link>. */
  hrefs: string[];
  /** Raw form action attributes. */
  formActions: string[];
  /** Endpoints already observed (e.g. from the network-capture buffer). */
  observedEndpoints?: string[];
};

/**
 * The function injected into the page to read links/forms. Self-contained (no
 * module scope); returns the raw strings for {@link foldHarvest} to normalize.
 */
export function harvestPageLinks(): { origin: string; hrefs: string[]; formActions: string[] } {
  const hrefs: string[] = [];
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    hrefs.push(a.href);
  }
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[href]"))) {
    hrefs.push(link.href);
  }
  const formActions: string[] = [];
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form[action]"))) {
    formActions.push(form.action);
  }
  return { origin: location.origin, hrefs, formActions };
}

// --- URL helpers --------------------------------------------------------------

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function toPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

// --- robots.txt parsing (pure) ------------------------------------------------

export function parseRobots(text: string): { sitemaps: string[]; disallow: string[]; allow: string[] } {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "sitemap") {
      sitemaps.push(value);
    } else if (key === "disallow") {
      disallow.push(value);
    } else if (key === "allow") {
      allow.push(value);
    }
  }
  return {
    sitemaps: dedupe(sitemaps),
    disallow: dedupe(disallow),
    allow: dedupe(allow)
  };
}

// --- sitemap parsing (pure) ---------------------------------------------------

/**
 * Extract <loc> URLs from a sitemap or sitemap-index XML. Returns both page URLs
 * and nested sitemap URLs (the caller decides whether to recurse). Regex-based
 * (no DOM in the SW); robust enough for the well-formed XML sitemaps emit.
 */
export function parseSitemap(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1].trim();
    if (url) {
      locs.push(url);
    }
  }
  return { locs: dedupe(locs), isIndex };
}

// --- Folding harvest + sitemap into the recon --------------------------------

export function foldHarvest(input: HarvestInput): ReconPath[] {
  const out: ReconPath[] = [];
  const push = (url: string, source: ReconPath["source"]) => {
    if (sameOrigin(url, input.origin)) {
      out.push({ url, path: toPath(url), source });
    }
  };
  for (const h of input.hrefs) push(h, "link");
  for (const f of input.formActions) push(f, "form");
  for (const e of input.observedEndpoints ?? []) push(e, "endpoint");
  return out;
}

export function dedupePaths(paths: ReconPath[]): ReconPath[] {
  const seen = new Map<string, ReconPath>();
  for (const p of paths) {
    // First source wins, but prefer a more specific source over "link".
    const existing = seen.get(p.path);
    if (!existing) {
      seen.set(p.path, p);
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// --- Orchestration (I/O — fetch robots + sitemaps) ----------------------------

const SITEMAP_URL_CAP = 500;
const SITEMAP_FETCH_CAP = 5; // index → at most this many child sitemaps
const FETCH_TIMEOUT_MS = 5_000;

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return undefined;
    }
    return await res.text();
  } catch {
    return undefined;
  }
}

/**
 * Build the site recon for an origin from the in-page harvest + robots/sitemaps.
 * `harvest` is the result of {@link harvestPageLinks} (gathered by the caller via
 * executeScript). `fetchImpl` is injectable for tests.
 */
export async function buildSiteRecon(args: {
  harvest: HarvestInput;
  fetchImpl?: (url: string) => Promise<string | undefined>;
}): Promise<SiteRecon> {
  const { origin } = args.harvest;
  const doFetch = args.fetchImpl ?? fetchText;
  const warnings: string[] = [];
  const collected: ReconPath[] = foldHarvest(args.harvest);

  // robots.txt
  const robotsResult = { fetched: false, sitemaps: [] as string[], disallow: [] as string[], allow: [] as string[] };
  let sitemapUrlCount = 0;
  const robotsText = await doFetch(`${origin}/robots.txt`);
  if (robotsText !== undefined) {
    robotsResult.fetched = true;
    const parsed = parseRobots(robotsText);
    robotsResult.sitemaps = parsed.sitemaps;
    robotsResult.disallow = parsed.disallow;
    robotsResult.allow = parsed.allow;
    for (const p of parsed.disallow) {
      collected.push({ url: `${origin}${p}`, path: p, source: "robots" });
    }
  } else {
    warnings.push("robots.txt not reachable.");
  }

  // Sitemaps: those declared in robots, else the conventional /sitemap.xml.
  const sitemapQueue = robotsResult.sitemaps.length ? [...robotsResult.sitemaps] : [`${origin}/sitemap.xml`];
  let fetchedSitemaps = 0;
  const seenSitemaps = new Set<string>();
  while (sitemapQueue.length && fetchedSitemaps < SITEMAP_FETCH_CAP && sitemapUrlCount < SITEMAP_URL_CAP) {
    const smUrl = sitemapQueue.shift()!;
    if (seenSitemaps.has(smUrl)) {
      continue;
    }
    seenSitemaps.add(smUrl);
    const xml = await doFetch(smUrl);
    fetchedSitemaps += 1;
    if (xml === undefined) {
      continue;
    }
    const { locs, isIndex } = parseSitemap(xml);
    if (isIndex) {
      // Enqueue child sitemaps (one level — capped by SITEMAP_FETCH_CAP).
      for (const child of locs) {
        if (!seenSitemaps.has(child)) {
          sitemapQueue.push(child);
        }
      }
    } else {
      for (const loc of locs) {
        if (sitemapUrlCount >= SITEMAP_URL_CAP) {
          warnings.push(`Sitemap URL cap (${SITEMAP_URL_CAP}) reached; inventory truncated.`);
          break;
        }
        if (sameOrigin(loc, origin)) {
          collected.push({ url: loc, path: toPath(loc), source: "sitemap" });
          sitemapUrlCount += 1;
        }
      }
    }
  }

  return {
    origin,
    paths: dedupePaths(collected),
    robots: robotsResult,
    sitemapUrlCount,
    warnings
  };
}

/** Compact rendering for the model/loop. */
export function renderSiteRecon(recon: SiteRecon, limit = 60): string {
  const lines: string[] = [`Site map for ${recon.origin} — ${recon.paths.length} path(s) discovered.`];
  if (recon.robots.fetched) {
    lines.push(`robots.txt: ${recon.robots.sitemaps.length} sitemap(s), ${recon.robots.disallow.length} disallow rule(s).`);
  }
  for (const p of recon.paths.slice(0, limit)) {
    lines.push(`- ${p.path} [${p.source}]`);
  }
  if (recon.paths.length > limit) {
    lines.push(`…and ${recon.paths.length - limit} more.`);
  }
  return lines.join("\n");
}
