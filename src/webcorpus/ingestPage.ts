/**
 * Convert one overlay capture into a flat PageEntry for the web corpus.
 *
 * This slice is deliberately FLAT: every captured actionable element becomes one
 * ComponentEntry (instanceCount 1, region "unknown", a per-element behaviorKey).
 * Behavioral dedup and regional segmentation are later slices that will collapse
 * and tag these — the schema slots already exist, so this stays an additive
 * change. No retrieval index is built here either.
 *
 * Also owns key normalization (SiteId / PageId), since that is what makes a
 * revisit fold into the SAME page entry rather than creating a duplicate.
 */

import { normalizeLabel } from "../tools/elementCorpus";
import type { ActionableElement, OverlayCaptureResult } from "../tools/elementOverlay";
import type {
  ComponentEntry,
  ComponentKind,
  PageEntry,
  PageRegion
} from "./webCorpusTypes";

/** scheme + lowercased host, no trailing slash. Returns undefined for non-URLs. */
export function toSiteId(rawUrl: string): { siteId: string; siteName: string } | undefined {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return undefined;
    }
    const host = u.host.toLowerCase();
    return { siteId: `${u.protocol}//${host}`, siteName: host };
  } catch {
    return undefined;
  }
}

/** origin + pathname, query string and hash stripped. Same logical page → same id. */
export function toPageId(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return undefined;
    }
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

function kindForElement(el: ActionableElement): ComponentKind {
  const role = el.role;
  if (role === "link" || el.tagName === "A") return "link";
  if (role === "button" || el.tagName === "BUTTON") return "button";
  if (role === "checkbox") return "checkbox";
  if (role === "radio") return "radio";
  if (role === "tab") return "tab";
  if (role === "menuitem") return "menuitem";
  if (el.tagName === "SELECT") return "select";
  if (el.tagName === "TEXTAREA") return "textarea";
  if (el.tagName === "INPUT") return "input";
  return "other";
}

/** Max concrete destination examples kept per deduped component. */
const MAX_DESTINATION_EXAMPLES = 3;

/**
 * Template a destination path so that links differing only by an identifier
 * collapse to the SAME pattern: the thing that lets 50 product-specific
 * "Add to cart" links share one behavior. Per path segment, replace anything
 * that looks like an identifier (pure numbers, long hex/uuid-ish strings, or
 * mixed strings carrying digits) with ":id". Deliberately segment-level and
 * heuristic — no learned patterns.
 */
export function destinationPattern(path: string): string {
  const [rawPath] = path.split(/[?#]/, 1);
  const segments = rawPath.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8,}$/i.test(seg)) return ":id"; // hex / uuid-ish
    if (/\d/.test(seg) && /[a-z]/i.test(seg) && seg.length >= 6) return ":id"; // slug-123
    return seg;
  });
  return segments.join("/") || "/";
}

/**
 * The dedup identity. Two elements with the same (kind + normalized name +
 * destination pattern) are the SAME component. Region is intentionally NOT in
 * the key yet — region is "unknown" for every element in this slice, so adding
 * it would be a no-op; it joins the key when segmentation lands.
 */
export function behaviorKeyFor(kind: ComponentKind, name: string, destPattern: string): string {
  return `${kind}|${name}|${destPattern}`;
}

function componentFromElement(pageId: string, el: ActionableElement): ComponentEntry {
  const name = normalizeLabel(el.accessibleName);
  const kind = kindForElement(el);
  const pattern = el.link ? destinationPattern(el.link.path) : "";
  const behaviorKey = behaviorKeyFor(kind, name, pattern);
  const destWords = el.link ? `${pattern} ${el.link.kind}` : "";
  const searchText = [name, destWords].filter(Boolean).join(" ").trim();
  const region: PageRegion = "unknown";
  return {
    id: `${pageId}#${behaviorKey}`,
    ordinal: el.index,
    behaviorKey,
    instanceCount: 1,
    kind,
    region,
    name,
    label: el.accessibleName,
    destination: el.link
      ? {
          pattern,
          kind: el.link.kind,
          rel: el.link.rel,
          examples: [el.link.path]
        }
      : undefined,
    searchText
  };
}

/**
 * Collapse components that share a behaviorKey into one entry. Keeps the lowest
 * ordinal (first occurrence in document order), sums instanceCount, and merges a
 * bounded set of concrete destination examples. Document order is preserved by
 * first-seen ordinal.
 */
function dedupeComponents(raw: ComponentEntry[]): ComponentEntry[] {
  const byKey = new Map<string, ComponentEntry>();
  for (const c of raw) {
    const existing = byKey.get(c.behaviorKey);
    if (!existing) {
      byKey.set(c.behaviorKey, c);
      continue;
    }
    existing.instanceCount += 1;
    existing.ordinal = Math.min(existing.ordinal, c.ordinal);
    if (existing.destination && c.destination) {
      for (const ex of c.destination.examples) {
        if (existing.destination.examples.length >= MAX_DESTINATION_EXAMPLES) break;
        if (!existing.destination.examples.includes(ex)) {
          existing.destination.examples.push(ex);
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Build a PageEntry from a capture. `capturedAt`/`visitCount` are placeholders
 * the store overwrites on persist (it owns visit accounting). Returns undefined
 * for pages we can't key (non-http(s), unparseable URL).
 */
export function ingestPage(
  capture: OverlayCaptureResult,
  now: string
): { siteId: string; siteName: string; page: PageEntry } | undefined {
  const site = toSiteId(capture.url);
  const pageId = toPageId(capture.url);
  if (!site || !pageId) {
    return undefined;
  }

  const rawComponents = capture.elements.map((el) => componentFromElement(pageId, el));
  const components = dedupeComponents(rawComponents);

  const page: PageEntry = {
    pageId,
    title: capture.title,
    lastUrl: capture.url,
    capturedAt: now,
    visitCount: 0,
    components,
    // Overlay capture maps the INTERACTION layer only; the research-content layer
    // is filled by the deterministic research loop. writePage preserves any
    // sections a prior research pass already wrote for this page.
    contentSections: [],
    rawElementCount: capture.candidateCount,
    dedupedCount: rawComponents.length - components.length,
    warnings: []
  };

  return { siteId: site.siteId, siteName: site.siteName, page };
}
