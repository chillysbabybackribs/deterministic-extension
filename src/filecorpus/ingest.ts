/**
 * Ingest one whole file into a persisted-ready FileCorpus: detect its kind,
 * map it into addressable units (via the per-type parsers), cap size, and
 * precompute the retrieval index. Runs in the side panel where the File bytes
 * live. The heavy PDF/XLSX parsers are dynamically imported by their modules,
 * so they only load when those types are actually ingested.
 */

import { makeId } from "../shared/id";
import type { FileCorpus, FileSourceKind, FileUnit } from "./corpusTypes";
import { buildIndex } from "./rankUnits";
import { parseDelimited } from "./parsers/delimited";
import { parseText } from "./parsers/text";
import type { ParseResult } from "./parsers/types";

/** Hard caps so a huge file can't blow up IndexedDB or the render budget. */
export const MAX_UNITS = 50_000;
export const MAX_UNIT_CHARS = 8_000;

export type IngestProgress = { phase: string };

export function detectSourceKind(fileName: string, mimeType: string): FileSourceKind | undefined {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (ext === "pdf" || mimeType === "application/pdf") {
    return "pdf";
  }
  if (ext === "xlsx" || ext === "xlsm" || mimeType.includes("spreadsheetml")) {
    return "xlsx";
  }
  if (ext === "csv" || mimeType === "text/csv") {
    return "csv";
  }
  if (ext === "tsv" || ext === "tab") {
    return "tsv";
  }
  if (ext === "md" || ext === "markdown") {
    return "markdown";
  }
  if (ext === "txt" || ext === "text" || mimeType.startsWith("text/")) {
    return "text";
  }
  return undefined;
}

async function runParser(file: File, kind: FileSourceKind): Promise<ParseResult> {
  switch (kind) {
    case "pdf": {
      const { parsePdf } = await import("./parsers/pdf");
      return parsePdf(await file.arrayBuffer());
    }
    case "xlsx": {
      const { parseXlsx } = await import("./parsers/xlsx");
      return parseXlsx(await file.arrayBuffer());
    }
    case "csv":
      return parseDelimited(await file.text(), ",");
    case "tsv":
      return parseDelimited(await file.text(), "\t");
    case "markdown":
      return parseText(await file.text(), true);
    case "text":
      return parseText(await file.text(), false);
  }
}

/**
 * Parse already-read text content into units, picking the parser from the file
 * name. Used by the folder ingest, which has text in hand (no File/bytes) for
 * each workspace file. Unknown/code/config/log files fall back to plain-text
 * parsing so they still get line numbers + section structure where present.
 */
export function parseTextContentToUnits(fileName: string, text: string): ParseResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseDelimited(text, ",");
  }
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) {
    return parseDelimited(text, "\t");
  }
  const isMarkdown = lower.endsWith(".md") || lower.endsWith(".markdown");
  return parseText(text, isMarkdown);
}

export async function ingestFile(
  file: File,
  onProgress?: (progress: IngestProgress) => void
): Promise<FileCorpus> {
  const kind = detectSourceKind(file.name, file.type);
  if (!kind) {
    throw new Error(
      `Unsupported file type: "${file.name}". Supported: .txt, .md, .csv, .tsv, .pdf, .xlsx.`
    );
  }

  onProgress?.({ phase: `Reading ${kind.toUpperCase()}…` });
  const parsed = await runParser(file, kind);
  const warnings = [...parsed.warnings];

  onProgress?.({ phase: "Mapping units…" });
  let parsedUnits = parsed.units;
  if (parsedUnits.length > MAX_UNITS) {
    warnings.push(`File exceeded ${MAX_UNITS.toLocaleString()} units; the rest was not indexed.`);
    parsedUnits = parsedUnits.slice(0, MAX_UNITS);
  }

  const fileId = makeId("corpus");
  const units: FileUnit[] = parsedUnits.map((unit, index) => ({
    id: `${fileId}:u${index}`,
    ordinal: index,
    kind: unit.kind,
    text: unit.text.length > MAX_UNIT_CHARS ? unit.text.slice(0, MAX_UNIT_CHARS) : unit.text,
    address: unit.address,
    structure: unit.structure
  }));

  onProgress?.({ phase: "Indexing…" });
  const index = buildIndex(units);

  return {
    fileId,
    fileName: file.name,
    sourceType: "file",
    sourceKind: kind,
    byteSize: file.size,
    ingestedAt: new Date().toISOString(),
    unitCount: units.length,
    warnings,
    units,
    index
  };
}
