/**
 * Parse a PDF into prose units, one paragraph per detected block, tagged with
 * its 1-based page number.
 *
 * pdfjs-dist is dynamically imported so its ~1MB does not load on panel boot —
 * only when a PDF is actually ingested. Runs on the main thread
 * (`disableWorker`) to avoid shipping/serving a separate worker file under the
 * extension CSP; ingest is a one-time cost so main-thread is acceptable.
 */

import type { ParseResult, ParsedUnit } from "./types";

const MIN_PARAGRAPH_CHARS = 24;

/** Group a page's text items into paragraphs using vertical gaps / blank lines. */
function paragraphsFromPageText(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length >= MIN_PARAGRAPH_CHARS);
}

export async function parsePdf(bytes: ArrayBuffer): Promise<ParseResult> {
  const pdfjs = await import("pdfjs-dist");
  // Main-thread mode: no separate worker script needed.
  // (Some builds honor GlobalWorkerOptions.workerSrc; disableWorker is the
  // reliable cross-version switch for extension contexts.)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false
  } as Parameters<typeof pdfjs.getDocument>[0]);

  const doc = await loadingTask.promise;
  const units: ParsedUnit[] = [];
  const warnings: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lineText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    // pdfjs collapses layout; reintroduce paragraph breaks on double-space runs
    // and sentence-ish boundaries so blocks are reasonable.
    const normalized = lineText.replace(/\s{2,}/g, "\n\n");
    for (const paragraph of paragraphsFromPageText(normalized)) {
      units.push({
        kind: "paragraph",
        text: paragraph,
        address: { page: pageNumber },
        structure: {}
      });
    }
  }

  if (!units.length) {
    warnings.push("No extractable text found in the PDF (it may be scanned images).");
  }

  return { units, warnings };
}
