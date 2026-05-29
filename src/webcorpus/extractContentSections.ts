/**
 * Deterministic page-content extractor (the research layer's "writer" input).
 *
 * Turns one already-captured PageSnapshot into clean, labelled, deduped
 * ContentSections carrying VERBATIM high-value text — no model, no DOM access
 * (it operates on the snapshot the existing collector already produced). This is
 * Slice 2 of the deterministic research loop: extract → strip → clean → label →
 * dedupe. The loop (Slice 3) calls this per page and writes the result to the
 * corpus; the model only ever sees the ranked sections, never the raw page.
 *
 * Design:
 *   - Prefer the snapshot's heading-pathed `sections`; fall back to splitting
 *     fullText/text on blank lines when structured extraction wasn't requested.
 *   - Strip boilerplate (nav/legal/cookie chrome, link-dumps, too-short blocks).
 *   - Title from the heading path, else the page title, else a derived label.
 *   - contentKey = normalized(title) + a stable hash of normalized text, so the
 *     same passage re-read or seen on two URLs collapses to one section.
 *   - Pure + unit-testable. Leaf module: imports only snapshot + corpus types.
 */

import type { PageSnapshot } from "../tools/snapshot/pageSnapshotTypes";
import type { ContentSection } from "./webCorpusTypes";

/** Minimum characters for a section to count as high-value (drops chrome/labels). */
const MIN_SECTION_CHARS = 120;
/** Max verbatim characters kept per section (bounds corpus + prompt size). */
const MAX_SECTION_CHARS = 4000;
/** Max sections kept per page (highest-value first by length, capped). */
const MAX_SECTIONS_PER_PAGE = 24;

/**
 * Phrases that mark a block as boilerplate chrome rather than content. Matched
 * case-insensitively against the (short) block; deliberately conservative so we
 * never strip real prose that merely mentions one of these words.
 */
const BOILERPLATE_PATTERNS = [
  /^accept (all )?cookies/i,
  /^we use cookies/i,
  /^this (web)?site uses cookies/i,
  /^(all rights reserved|© ?\d{4})/i,
  /^(privacy policy|terms of service|terms of use|cookie policy)$/i,
  /^(sign in|sign up|log ?in|subscribe|newsletter)$/i,
  /^(skip to (main )?content|back to top)$/i,
  /^(share|tweet|follow us)$/i
];

type RawBlock = { title: string; text: string };

export function extractContentSections(snapshot: PageSnapshot, now: string): ContentSection[] {
  const blocks = rawBlocks(snapshot);
  const url = snapshot.url;

  // Dedupe within the page by contentKey while preserving first-seen order.
  const byKey = new Map<string, ContentSection>();
  let ordinal = 0;
  for (const block of blocks) {
    const text = cleanText(block.text);
    if (!isHighValue(block.title, text)) {
      continue;
    }
    const title = deriveTitle(block.title, text, snapshot.title);
    const contentKey = makeContentKey(title, text);
    const existing = byKey.get(contentKey);
    if (existing) {
      if (url && !existing.sourceUrls.includes(url)) {
        existing.sourceUrls.push(url);
      }
      continue;
    }
    const id = `${snapshot.url}#s${ordinal}`;
    byKey.set(contentKey, {
      id,
      ordinal,
      contentKey,
      title,
      text,
      sourceUrls: url ? [url] : [],
      capturedAt: now,
      searchText: `${title} ${text}`
    });
    ordinal += 1;
  }

  // Keep the highest-value sections (longest verbatim text wins), capped, but
  // restore document order for stable display/citation.
  return Array.from(byKey.values())
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_SECTIONS_PER_PAGE)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** Snapshot → raw (title, text) blocks, preferring structured sections. */
function rawBlocks(snapshot: PageSnapshot): RawBlock[] {
  if (snapshot.sections?.length) {
    return snapshot.sections.map((section) => ({
      title: section.headingPath?.length ? section.headingPath[section.headingPath.length - 1] : "",
      text: section.text
    }));
  }
  // Fallback: split the readable text on blank lines into paragraph blocks.
  const body = snapshot.fullText || snapshot.text || "";
  return body
    .split(/\n{2,}/)
    .map((block) => ({ title: "", text: block }))
    .filter((block) => block.text.trim().length > 0);
}

function cleanText(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SECTION_CHARS);
}

/** A section is high-value if it has enough prose and isn't recognizable chrome. */
function isHighValue(title: string, text: string): boolean {
  if (text.length < MIN_SECTION_CHARS) {
    return false;
  }
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text) || (title && pattern.test(title)))) {
    return false;
  }
  // Link-dump heuristic: a block that is almost entirely short lines (nav/menus)
  // carries little prose. Require a reasonable share of "sentence-like" content.
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 6) {
    const shortLines = lines.filter((line) => line.length < 40).length;
    if (shortLines / lines.length > 0.8) {
      return false;
    }
  }
  return true;
}

/** Title from the heading, else the page title, else the first sentence/clause. */
function deriveTitle(headingTitle: string, text: string, pageTitle: string): string {
  const heading = headingTitle.replace(/\s+/g, " ").trim();
  if (heading) {
    return heading.slice(0, 160);
  }
  const firstSentence = text.split(/(?<=[.!?])\s/)[0]?.trim();
  if (firstSentence && firstSentence.length >= 12 && firstSentence.length <= 160) {
    return firstSentence;
  }
  const page = pageTitle.replace(/\s+/g, " ").trim();
  if (page) {
    return page.slice(0, 160);
  }
  return text.slice(0, 60).trim() || "(untitled section)";
}

/** Normalized title + a stable hash of normalized text. Pure + collision-cheap. */
function makeContentKey(title: string, text: string): string {
  const normTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normText = text.toLowerCase().replace(/\s+/g, " ").trim();
  return `${normTitle}|${hash(normText)}`;
}

/** Small, stable, dependency-free string hash (djb2). Not cryptographic. */
function hash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
