/**
 * Element corpus + deterministic grep search (v1).
 *
 * Turns an overlay capture into a CORPUS — one document per actionable element
 * with a normalized accessible name. The user's target phrase is then GREPPED
 * over that corpus with a deliberately simple contract:
 *
 *   - EXACT: the normalized target equals exactly ONE element's normalized name
 *     → that element is the answer, fire it deterministically (no model).
 *   - SHORTLIST: otherwise, return up to K candidate elements for the model
 *     (Haiku) to choose from. v1 shortlist = elements whose name CONTAINS the
 *     target words (a cheap grep), else the whole list — order is document order,
 *     NOT a score. The model does the real picking.
 *   - NONE: corpus empty / no target.
 *
 * Deliberately NO scoring/ranking/thresholds in v1. Synonym/variation matching
 * (sign-in/sign-up/register, "log me in" → "Sign in") is a LATER, explicit
 * upgrade layered on top of exact-match once exact is confirmed working.
 */

import type { ActionableElement, OverlayCaptureResult } from "./elementOverlay";

// --- Corpus -------------------------------------------------------------------

export type ElementDoc = {
  /** The element this doc describes (carries the deterministic overlay index). */
  element: ActionableElement;
  /** Normalized accessible name (lowercased, punctuation→space, collapsed). */
  name: string;
  /** Normalized name tokens, for contains-grep. */
  nameTokens: string[];
};

export type ElementCorpus = {
  docs: ElementDoc[];
  size: number;
};

/**
 * Normalize a label/target for exact comparison: lowercase, strip punctuation to
 * spaces, collapse whitespace, trim. "Sign In!" and "  sign  in " both → "sign in".
 */
export function normalizeLabel(text: string | undefined | null): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCorpus(capture: Pick<OverlayCaptureResult, "elements">): ElementCorpus {
  const docs: ElementDoc[] = capture.elements.map((element) => {
    const name = normalizeLabel(element.accessibleName);
    return { element, name, nameTokens: name ? name.split(" ") : [] };
  });
  return { docs, size: docs.length };
}

// --- Search (deterministic grep) ----------------------------------------------

export type CorpusSearchResult =
  | { kind: "exact"; winner: ActionableElement }
  | { kind: "shortlist"; candidates: ActionableElement[] }
  | { kind: "none" };

export type SearchOptions = {
  /** Max candidates handed to the model when not an exact match. Default 5. */
  shortlistLimit?: number;
  /** Restrict exact/shortlist candidates to real link-like elements. */
  requireLink?: boolean;
  /** Current page URL, used to identify self-links. */
  currentUrl?: string;
  /** Prefer destinations that are not the current page URL when available. */
  preferNonCurrentUrl?: boolean;
};

/**
 * Grep the corpus for the target phrase.
 *   exact     → exactly one element's normalized name equals the normalized target.
 *   shortlist → otherwise, up to K candidates (names containing the target words,
 *               else the whole list) in document order, for the model to choose.
 *   none      → empty corpus or empty target.
 */
export function searchCorpus(
  target: string,
  corpus: ElementCorpus,
  options: SearchOptions = {}
): CorpusSearchResult {
  const normTarget = normalizeLabel(target);
  if (!normTarget || corpus.size === 0) {
    return { kind: "none" };
  }
  const limit = options.shortlistLimit ?? 5;
  const baseDocs = options.requireLink ? corpus.docs.filter(isLinkDoc) : corpus.docs;
  const docs = options.preferNonCurrentUrl
    ? preferNonCurrentDocs(baseDocs, options.currentUrl)
    : baseDocs;
  if (!docs.length) {
    return { kind: "none" };
  }

  // EXACT: normalized name equality. Fire only if it is UNIQUELY identified.
  const exactMatches = docs.filter((d) => d.name === normTarget);
  if (exactMatches.length === 1) {
    return { kind: "exact", winner: exactMatches[0].element };
  }

  // SHORTLIST. Prefer elements whose name contains ALL target words, then ANY,
  // then fall back to the whole corpus — document order throughout (no score).
  const targetWords = normTarget.split(" ");
  const containsAll = docs.filter(
    (d) => d.name && targetWords.every((w) => d.nameTokens.includes(w))
  );
  const containsAny = docs.filter(
    (d) => d.name && targetWords.some((w) => d.nameTokens.includes(w))
  );

  // If exact had MULTIPLE hits, those are the most relevant shortlist head.
  const ordered = dedupeDocs([
    ...exactMatches,
    ...containsAll,
    ...containsAny,
    ...docs
  ]);

  const candidates = ordered.slice(0, limit).map((d) => d.element);
  return candidates.length ? { kind: "shortlist", candidates } : { kind: "none" };
}

function isLinkDoc(doc: ElementDoc): boolean {
  const el = doc.element;
  return Boolean(
    el.link ||
    el.role === "link" ||
    el.tagName.toLowerCase() === "a" ||
    el.attributes.hasHref
  );
}

function preferNonCurrentDocs(docs: ElementDoc[], currentUrl: string | undefined): ElementDoc[] {
  if (!currentUrl) {
    return docs;
  }
  const nonCurrent = docs.filter((doc) => !isCurrentPageLink(doc.element, currentUrl));
  return nonCurrent.length ? nonCurrent : docs;
}

function isCurrentPageLink(el: ActionableElement, currentUrl: string): boolean {
  return Boolean(el.link?.href && sameComparableUrl(el.link.href) === sameComparableUrl(currentUrl));
}

function sameComparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function dedupeDocs(docs: ElementDoc[]): ElementDoc[] {
  const seen = new Set<number>();
  const out: ElementDoc[] = [];
  for (const d of docs) {
    if (!seen.has(d.element.index)) {
      seen.add(d.element.index);
      out.push(d);
    }
  }
  return out;
}

/** Compact one-line rendering of a candidate for the model shortlist payload. */
export function renderCandidate(el: ActionableElement, options: { currentUrl?: string } = {}): string {
  const name = el.accessibleName ? `"${el.accessibleName}"` : "(no name)";
  const self = options.currentUrl && isCurrentPageLink(el, options.currentUrl) ? " (current page)" : "";
  const dest = el.link ? ` → ${el.link.path}${self}` : "";
  return `#${el.index} ${el.role ?? el.tagName} ${name}${dest}`;
}
