import type {
  PageCodeBlock,
  PageForm,
  PageMetadata,
  PagePriceCandidate,
  PageSnapshot,
  PageTable,
  PageTargetedSection,
  PageTextSection
} from "./pageSnapshotTypes";

export function collectPageSnapshot(options: { maxChars: number; includeLinks: boolean; includeStructured?: boolean; targetedTerms?: string[]; fullTextMaxChars?: number }): PageSnapshot {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const fullTextMaxChars = Math.max(maxChars, Math.floor(options.fullTextMaxChars ?? maxChars));
  const includeStructured = options.includeStructured === true;
  const description =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ||
    undefined;
  const metadata = includeStructured ? collectMetadata() : undefined;
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 60);
  const selection = includeStructured
    ? (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim().slice(0, 1600) || undefined
    : undefined;
  const normalizedText = (document.body?.innerText ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = normalizedText.slice(0, maxChars);
  const fullText = normalizedText.slice(0, fullTextMaxChars);
  const sections = includeStructured ? extractTextSections(fullText, headings) : undefined;
  const links = options.includeLinks
    ? Array.from(document.links)
        .map((link) => ({
          text: (link.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          url: link.href
        }))
        .filter((link) => link.url && /^https?:\/\//i.test(link.url))
        .slice(0, 120)
    : [];

  const tables = includeStructured ? collectTables() : undefined;
  const codeBlocks = includeStructured ? collectCodeBlocks() : undefined;
  const priceCandidates = includeStructured ? collectPriceCandidates(normalizedText, 12) : undefined;
  const targetedSections = includeStructured
    ? extractTargetedSections(fullText, headings, options.targetedTerms)
    : undefined;

  return {
    url: location.href,
    title: document.title,
    description,
    metadata,
    headings,
    selection,
    text,
    fullText,
    sections,
    links,
    tables,
    codeBlocks,
    forms: includeStructured ? collectForms() : undefined,
    priceCandidates,
    targetedSections,
    truncation: {
      text: normalizedText.length > maxChars,
      fullText: normalizedText.length > fullTextMaxChars,
      sections: Boolean(sections?.some((section) => section.truncated)),
      tables: Boolean(tables?.some((table) => table.truncated)),
      tableRows: Boolean(tables?.some((table) => table.truncated)),
      codeBlocks: Boolean(codeBlocks?.some((block) => block.truncated)),
      priceCandidates: Boolean(priceCandidates?.some((candidate) => candidate.truncated)),
      targetedSections: Boolean(targetedSections?.some((section) => section.truncated))
    }
  };

  function collectMetadata(): PageMetadata {
    const keywords = readMeta("keywords")
      ?.split(",")
      .map((keyword) => keyword.trim())
      .filter(Boolean)
      .slice(0, 20);

    return {
      canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || undefined,
      language: document.documentElement.lang || undefined,
      author: readMeta("author") || undefined,
      publishedTime: readMeta("article:published_time") || readMeta("published_time") || undefined,
      modifiedTime: readMeta("article:modified_time") || readMeta("modified_time") || undefined,
      siteName: readMeta("og:site_name") || undefined,
      pageType: readMeta("og:type") || undefined,
      keywords: keywords?.length ? keywords : undefined
    };
  }

  function collectTables(): PageTable[] {
    return Array.from(document.querySelectorAll("table"))
      .map((table) => {
        const caption = normalize(table.querySelector("caption")?.textContent ?? "");
        const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
          Array.from(row.querySelectorAll("th, td"))
            .map((cell) => normalize(cell.textContent ?? "").slice(0, 240))
            .filter(Boolean)
        ).filter((row) => row.length);
        const firstHeaderRow = Array.from(table.querySelectorAll("tr")).find((row) => row.querySelector("th"));
        const headers = firstHeaderRow
          ? Array.from(firstHeaderRow.querySelectorAll("th")).map((cell) => normalize(cell.textContent ?? "").slice(0, 180)).filter(Boolean)
          : [];
        const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

        const displayedRowStart = headers.length ? 1 : 0;
        const displayedRows = rows.slice(displayedRowStart, displayedRowStart + 6);
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

  function collectCodeBlocks(): PageCodeBlock[] {
    return Array.from(document.querySelectorAll("pre, code"))
      .map((node) => {
        const text = normalizePreformatted(node.textContent ?? "");
        const className = (node.getAttribute("class") ?? "").toLowerCase();
        const language = className.match(/(?:language|lang)-([a-z0-9_+-]+)/)?.[1];
        return {
          language,
          text: text.slice(0, 1600),
          truncated: text.length > 1600
        };
      })
      .filter((block) => block.text.length >= 12)
      .slice(0, 8);
  }

  function collectForms(): PageForm[] {
    return Array.from(document.forms)
      .map((form) => ({
        id: form.id || undefined,
        name: form.getAttribute("name") || undefined,
        action: form.action || undefined,
        method: form.method || undefined,
        fields: Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
          .map((field) => {
            const id = field.id;
            const label = id
              ? normalize(document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)?.textContent ?? "")
              : normalize(field.closest("label")?.textContent ?? "");
            const options = field instanceof HTMLSelectElement
              ? Array.from(field.options).map((option) => normalize(option.textContent ?? option.value)).filter(Boolean).slice(0, 12)
              : undefined;

            return {
              label: label || undefined,
              name: field.getAttribute("name") || undefined,
              type: field instanceof HTMLInputElement ? field.type : field.tagName.toLowerCase(),
              placeholder: field.getAttribute("placeholder") || undefined,
              required: field.required || undefined,
              options: options?.length ? options : undefined
            };
          })
          .slice(0, 30)
      }))
      .filter((form) => form.fields.length)
      .slice(0, 6);
  }

  function extractTextSections(
    value: string,
    headingValues: string[],
    maxSections = 120
  ): PageTextSection[] {
    const normalizedHeadings = headingValues
      .map((heading) => heading.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const headingSet = new Set(normalizedHeadings.map((heading) => heading.toLowerCase()));
    const blocks = value
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
    value: string,
    headingValues: string[],
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

    const paragraphs = value
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
      const headingPath = nearestHeadingPath(paragraphs, headingValues, item.index);
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
    value: string,
    matchedTerms: string[],
    maxChars: number
  ): { text: string; truncated: boolean } {
    if (value.length <= maxChars) {
      return { text: value, truncated: false };
    }

    const valueMatch = value.match(/\$[\d,.]+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:[KMB]|%|tokens?|tok|mtok|requests?|users?|hours?|days?|months?|years?|GB|MB|rpm|rps|qps)\b/i);
    const valueIndex = valueMatch?.index ?? -1;
    const sortedTerms = [...matchedTerms].sort((left, right) => right.length - left.length);
    const termIndex = sortedTerms.reduce((best, term) => {
      const index = value.toLowerCase().indexOf(term.toLowerCase());
      return index >= 0 && (best < 0 || index < best) ? index : best;
    }, -1);
    const anchor = valueIndex >= 0 ? valueIndex : termIndex >= 0 ? termIndex : 0;
    const start = Math.max(0, anchor - Math.floor(maxChars / 3));
    const end = Math.min(value.length, start + maxChars);

    return {
      text: value.slice(start, end),
      truncated: true
    };
  }

  function termMatch(value: string, term: string): boolean {
    if (/\s/.test(term)) {
      return value.includes(term);
    }

    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(value);
  }

  function nearestHeadingPath(paragraphs: string[], headingValues: string[], index: number): string[] | undefined {
    const normalizedHeadings = headingValues
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

  function collectPriceCandidates(value: string, maxResults: number): PagePriceCandidate[] {
    const normalized = normalize(value);
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

  function readMeta(name: string): string | undefined {
    return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() ||
      document.querySelector<HTMLMetaElement>(`meta[property="${name}"]`)?.content.trim() ||
      undefined;
  }

  function normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function normalizePreformatted(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

