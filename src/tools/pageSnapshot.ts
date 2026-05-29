import { cleanText, matchFirst, stripTags } from "../shared/textUtils";
import { domainFromUrl } from "../shared/urlUtils";
import { collectPageSnapshot } from "./snapshot/collectPageSnapshot";
import type {
  PageCodeBlock,
  PageForm,
  PageMetadata,
  PagePriceCandidate,
  PageSnapshot,
  PageTable,
  PageTargetedSection,
  PageTextSection
} from "./snapshot/pageSnapshotTypes";

export type {
  PageCodeBlock,
  PageForm,
  PageFormField,
  PageLink,
  PageMetadata,
  PagePriceCandidate,
  PageSnapshot,
  PageSnapshotTruncation,
  PageTable,
  PageTargetedSection,
  PageTextSection
} from "./snapshot/pageSnapshotTypes";

export async function snapshotTab(
  tabId: number,
  options: { maxChars: number; includeLinks: boolean; includeStructured?: boolean; targetedTerms?: string[]; fullTextMaxChars?: number }
): Promise<PageSnapshot> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageSnapshot,
    args: [options]
  });

  if (!result?.result) {
    throw new Error("Page snapshot returned no content.");
  }

  return result.result;
}

export function snapshotFromFetchedText(
  url: string,
  raw: string,
  contentType: string,
  maxChars: number,
  options: { targetedTerms?: string[]; fullTextMaxChars?: number } = {}
): PageSnapshot {
  const fullTextMaxChars = Math.max(maxChars, options.fullTextMaxChars ?? 120000);
  if (/text\/plain/i.test(contentType)) {
    const cleaned = cleanText(raw);
    const fullText = cleaned.slice(0, fullTextMaxChars);
    const sections = extractTextSections(fullText, []);
    const targetedSections = extractTargetedSections(fullText, [], options.targetedTerms);
    return {
      url,
      title: domainFromUrl(url) ?? url,
      metadata: {},
      headings: [],
      text: cleaned.slice(0, maxChars),
      fullText,
      sections,
      links: [],
      priceCandidates: extractPriceCandidates(cleaned, 8),
      targetedSections,
      truncation: {
        text: cleaned.length > maxChars,
        fullText: cleaned.length > fullTextMaxChars,
        sections: sections.some((section) => section.truncated),
        targetedSections: targetedSections.some((section) => section.truncated)
      }
    };
  }

  const html = raw.slice(0, 1_000_000);
  const title = cleanText(stripTags(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? ""));
  const description = cleanText(
    matchFirst(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i) ??
      matchFirst(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i) ??
      ""
  ) || undefined;
  const headings = Array.from(html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((match) => cleanText(stripTags(match[1])))
    .filter(Boolean)
    .slice(0, 60);
  const body = matchFirst(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  const fullText = cleanText(
    stripTags(
      body
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<(br|p|div|section|article|main|li|h[1-6]|tr)\b[^>]*>/gi, "\n$&")
    )
  );
  const text = fullText.slice(0, maxChars);
  const dossierText = fullText.slice(0, fullTextMaxChars);
  const sections = extractTextSections(dossierText, headings);
  const targetedSections = extractTargetedSections(dossierText, headings, options.targetedTerms);
  const tables = extractHtmlTables(html);

  return {
    url,
    title: title || domainFromUrl(url) || url,
    description,
    metadata: extractHtmlMetadata(url, html),
    headings,
    text,
    fullText: dossierText,
    sections,
    links: [],
    tables,
    codeBlocks: extractHtmlCodeBlocks(html),
    priceCandidates: extractPriceCandidates(fullText, 8),
    targetedSections,
    truncation: {
      html: raw.length > html.length,
      text: fullText.length > maxChars,
      fullText: fullText.length > fullTextMaxChars,
      sections: sections.some((section) => section.truncated),
      tables: tables.some((table) => table.truncated),
      tableRows: tables.some((table) => table.truncated),
      targetedSections: targetedSections.some((section) => section.truncated)
    }
  };
}


function extractHtmlMetadata(url: string, html: string): PageMetadata {
  const keywords = readMeta(html, "keywords")
    ?.split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 20);

  return {
    canonicalUrl: matchFirst(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) ||
      matchFirst(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i) ||
      undefined,
    language: matchFirst(html, /<html[^>]+lang=["']([^"']+)["']/i) || undefined,
    author: readMeta(html, "author") || undefined,
    publishedTime: readMeta(html, "article:published_time") || readMeta(html, "published_time") || undefined,
    modifiedTime: readMeta(html, "article:modified_time") || readMeta(html, "modified_time") || undefined,
    siteName: readMeta(html, "og:site_name") || domainFromUrl(url) || undefined,
    pageType: readMeta(html, "og:type") || undefined,
    keywords: keywords?.length ? keywords : undefined
  };
}

function extractHtmlTables(html: string): PageTable[] {
  return Array.from(html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi))
    .map((match) => {
      const tableHtml = match[1];
      const caption = cleanText(stripTags(matchFirst(tableHtml, /<caption\b[^>]*>([\s\S]*?)<\/caption>/i) ?? ""));
      const rowEntries = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).map((rowMatch) => ({
        hasHeader: /<th\b/i.test(rowMatch[1]),
        cells: Array.from(rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi))
          .map((cellMatch) => cleanText(stripTags(cellMatch[2])).slice(0, 240))
          .filter(Boolean)
      })).filter((row) => row.cells.length);
      const rows = rowEntries.map((row) => row.cells);
      const headerRowIndex = rowEntries.findIndex((row) => row.hasHeader);
      const headers = headerRowIndex >= 0
        ? rows[headerRowIndex]?.map((cell) => cell.slice(0, 180)) ?? []
        : [];
      const displayedRowStart = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
      const displayedRows = rows.slice(displayedRowStart, displayedRowStart + 6);
      const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

      return {
        caption: caption || undefined,
        headers,
        rows: displayedRows,
        rowCount: rows.length,
        columnCount,
        truncated: rows.length - displayedRowStart > displayedRows.length
      };
    })
    .filter((table) => table.rowCount && table.columnCount)
    .slice(0, 6);
}

function extractHtmlCodeBlocks(html: string): PageCodeBlock[] {
  return Array.from(html.matchAll(/<(pre|code)\b([^>]*)>([\s\S]*?)<\/\1>/gi))
    .map((match) => {
      const attrs = match[2] ?? "";
      const className = matchFirst(attrs, /class=["']([^"']+)["']/i)?.toLowerCase() ?? "";
      const text = cleanText(stripTags(match[3]));
      return {
        language: className.match(/(?:language|lang)-([a-z0-9_+-]+)/)?.[1],
        text: text.slice(0, 1600),
        truncated: text.length > 1600
      };
    })
    .filter((block) => block.text.length >= 12)
    .slice(0, 8);
}

function extractPriceCandidates(text: string, maxResults: number): PagePriceCandidate[] {
  const normalized = cleanText(text);
  const pattern = /\b(?:USD|CAD|AUD|EUR|GBP)\s*\d[\d,]*(?:\.\d{2})?\b|\$\s*\d[\d,]*(?:\.\d{2})?/gi;
  const candidates: PagePriceCandidate[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized)) && candidates.length < maxResults) {
    const text = match[0].replace(/\s+/g, " ").trim();
    if (seen.has(text)) {
      continue;
    }

    seen.add(text);
    candidates.push({
      text,
      context: normalized.slice(Math.max(0, match.index - 80), Math.min(normalized.length, match.index + text.length + 120)).trim()
    });
  }

  if (candidates.length >= maxResults && pattern.exec(normalized)) {
    candidates[candidates.length - 1] = {
      ...candidates[candidates.length - 1],
      truncated: true
    };
  }

  return candidates;
}

function extractTextSections(
  text: string,
  headings: string[],
  maxSections = 120
): PageTextSection[] {
  const normalizedHeadings = headings
    .map((heading) => heading.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const headingSet = new Set(normalizedHeadings.map((heading) => heading.toLowerCase()));
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const sections: PageTextSection[] = [];
  let currentHeadingPath: string[] = normalizedHeadings.slice(0, 1);
  let currentBlocks: string[] = [];
  let currentStart = 0;

  const flush = () => {
    if (!currentBlocks.length || sections.length >= maxSections) {
      currentBlocks = [];
      return;
    }

    const sectionText = currentBlocks.join("\n\n");
    sections.push({
      headingPath: currentHeadingPath.length ? currentHeadingPath.slice(0, 4) : undefined,
      text: sectionText.slice(0, 6000),
      start: currentStart,
      truncated: sectionText.length > 6000
    });
    currentBlocks = [];
  };

  for (let index = 0; index < blocks.length && sections.length < maxSections; index += 1) {
    const block = blocks[index];
    const isHeading = block.length <= 180 && headingSet.has(block.toLowerCase());
    if (isHeading) {
      flush();
      currentHeadingPath = [block];
      currentStart = index;
      continue;
    }

    if (!currentBlocks.length) {
      currentStart = index;
    }
    currentBlocks.push(block);

    if (currentBlocks.join("\n\n").length >= 5000) {
      flush();
    }
  }

  flush();
  return sections;
}

function extractTargetedSections(
  text: string,
  headings: string[],
  targetedTerms: string[] | undefined,
  maxSections = 6
): PageTargetedSection[] {
  const terms = Array.from(new Set((targetedTerms ?? [])
    .map((term) => term.toLowerCase().replace(/\s+/g, " ").trim())
    .filter((term) => term.length >= 3)))
    .slice(0, 32);
  if (!terms.length) {
    return [];
  }

  const paragraphs = text
    .split(/\n{2,}|\n(?=[A-Z0-9][^\n]{0,120}(?:$|\n))/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 24);
  const scored = paragraphs
    .map((paragraph, index) => {
      const lower = paragraph.toLowerCase();
      const matchedTerms = terms.filter((term) => termMatch(lower, term));
      const valueScore = /\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:[KMB]|%|tokens?|tok|mtok|requests?|users?|hours?|days?|months?|years?|GB|MB|rpm|rps|qps)\b/i.test(paragraph)
        ? 4
        : 0;

      return {
        index,
        matchedTerms,
        score: matchedTerms.length * 8 + valueScore + Math.max(0, 3 - index)
      };
    })
    .filter((item) => item.matchedTerms.length)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const used = new Set<number>();
  const sections: PageTargetedSection[] = [];

  for (const item of scored) {
    if (sections.length >= maxSections) {
      break;
    }
    if (used.has(item.index)) {
      continue;
    }

    const start = Math.max(0, item.index - 1);
    const end = Math.min(paragraphs.length, item.index + 3);
    for (let index = start; index < end; index += 1) {
      used.add(index);
    }

    const rawSectionText = paragraphs.slice(start, end).join("\n");
    const sectionMatchedTerms = terms.filter((term) => termMatch(rawSectionText.toLowerCase(), term));
    const sectionText = cropTargetedSection(rawSectionText, sectionMatchedTerms, 1800);
    const headingPath = nearestHeadingPath(paragraphs, headings, item.index);
    sections.push({
      headingPath,
      matchedTerms: sectionMatchedTerms.slice(0, 8),
      text: sectionText.text,
      truncated: sectionText.truncated
    });
  }

  return sections;
}

function cropTargetedSection(
  text: string,
  matchedTerms: string[],
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const valueMatch = text.match(/\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:[KMB]|%|tokens?|tok|mtok|requests?|users?|hours?|days?|months?|years?|GB|MB|rpm|rps|qps)\b/i);
  const valueIndex = valueMatch?.index ?? -1;
  const sortedTerms = [...matchedTerms].sort((left, right) => right.length - left.length);
  const termIndex = sortedTerms.reduce((best, term) => {
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const anchor = valueIndex >= 0 ? valueIndex : termIndex >= 0 ? termIndex : 0;
  const start = Math.max(0, anchor - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);

  return {
    text: text.slice(start, end),
    truncated: true
  };
}

function termMatch(text: string, term: string): boolean {
  if (/\s/.test(term)) {
    return text.includes(term);
  }

  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(text);
}

function nearestHeadingPath(paragraphs: string[], headings: string[], index: number): string[] | undefined {
  const normalizedHeadings = headings
    .map((heading) => heading.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!normalizedHeadings.length) {
    return undefined;
  }

  const searchStart = Math.max(0, index - 8);
  for (let paragraphIndex = index; paragraphIndex >= searchStart; paragraphIndex -= 1) {
    const paragraph = paragraphs[paragraphIndex]?.toLowerCase();
    const heading = normalizedHeadings.find((candidate) => paragraph === candidate.toLowerCase());
    if (heading) {
      return [heading];
    }
  }

  return normalizedHeadings.slice(0, 3);
}

function readMeta(html: string, name: string): string | undefined {
  return cleanText(
    matchFirst(html, new RegExp(`<meta[^>]+(?:name|property)=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i")) ??
      matchFirst(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapeRegExp(name)}["'][^>]*>`, "i")) ??
      ""
  ) || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
