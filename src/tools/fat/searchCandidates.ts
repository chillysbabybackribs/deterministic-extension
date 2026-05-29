/**
 * Intent-free search-result link extraction for the search_web tool.
 *
 * Turns raw result-page links into clean, deduped SearchCandidate objects:
 * resolves Google /url redirects, drops Google infrastructure/utility links, and
 * dedupes by normalized URL. Deliberately NO relevance scoring — ordering is the
 * page's own result order; the model picks which candidate to open.
 *
 * (Lifted from the deleted deterministic research runner's candidates module —
 * only the intent-free pieces the tool actually needs.)
 */

import type { SearchCandidate } from "../../evidence/evidenceTypes";
import { makeId } from "../../shared/id";
import { clipWithTruncation as clip, decodeHtml } from "../../shared/textUtils";
import { domainFromUrl, normalizeForDedupe } from "../../shared/urlUtils";

export function candidatesFromLinks(
  links: Array<{ text: string; url: string }>,
  maxResults: number
): SearchCandidate[] {
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];

  for (const link of links) {
    const url = normalizeSearchResultUrl(link.url);
    if (!url || isUtilityCandidate(url, link.text) || seen.has(normalizeForDedupe(url))) {
      continue;
    }

    seen.add(normalizeForDedupe(url));
    candidates.push({
      id: makeId("candidate"),
      title: clip(link.text || domainFromUrl(url) || url, 180),
      url,
      domain: domainFromUrl(url)
    });

    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

function normalizeSearchResultUrl(rawHref: string): string | undefined {
  const decoded = decodeHtml(rawHref);
  let resolved: URL;
  try {
    resolved = new URL(decoded, "https://www.google.com");
  } catch {
    return undefined;
  }

  if (resolved.hostname === "www.google.com" || resolved.hostname === "google.com") {
    if (resolved.pathname === "/url") {
      const target = resolved.searchParams.get("q") ?? resolved.searchParams.get("url");
      if (!target) {
        return undefined;
      }
      try {
        resolved = new URL(target);
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  if (isGoogleInfrastructureUrl(resolved)) {
    return undefined;
  }

  resolved.hash = "";
  return resolved.href;
}

function isUtilityCandidate(url: string, title: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const normalizedTitle = title.toLowerCase();

  if (host === "support.google.com" && path.startsWith("/websearch")) {
    return true;
  }
  if (host === "support.google.com" && /google search help|manage your google account|feedback/.test(normalizedTitle)) {
    return true;
  }

  return /\b(cached|similar pages|feedback|privacy|terms|settings)\b/.test(normalizedTitle);
}

/**
 * Google's own properties/tools that show up among SERP links but are never the
 * organic result the user searched for. Includes product subdomains like
 * labs.google / maps.google.com / support.google.com that previously slipped
 * through and got picked as a top candidate (the "Top results... 1. labs" case).
 */
const GOOGLE_PRODUCT_HOSTS = new Set([
  "labs.google",
  "labs.google.com",
  "maps.google.com",
  "translate.google.com",
  "books.google.com",
  "scholar.google.com",
  "play.google.com",
  "news.google.com",
  "images.google.com",
  "myactivity.google.com",
  "support.google.com",
  "accounts.google.com",
  "policies.google.com"
]);

function isGoogleInfrastructureUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (GOOGLE_PRODUCT_HOSTS.has(host) || host.endsWith(".gstatic.com")) {
    return true;
  }
  // Any google.com search/utility surface (incl. www) is not an organic result.
  if (host === "www.google.com" || host === "google.com") {
    return true;
  }
  // labs.google and other "<product>.google" bare-TLD product hosts.
  if (host === "google" || host.endsWith(".google")) {
    return true;
  }
  return false;
}
