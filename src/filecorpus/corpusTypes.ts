/**
 * Types for the "work from a file" corpus.
 *
 * A FileCorpus is the result of ingesting one whole file once: every
 * addressable unit (a prose paragraph/section, or a tabular row) is mapped with
 * its location and structural metadata, plus a precomputed retrieval index so
 * that ranking a prompt against the corpus is O(query terms), not a full
 * re-tokenize of the file on every turn.
 *
 * Leaf module: no imports from the pipeline/UI so it never participates in an
 * import cycle (mirrors how conversationTypes stays a leaf).
 */

export type UnitKind = "paragraph" | "section" | "row" | "cell";

export type FileSourceKind = "text" | "markdown" | "csv" | "tsv" | "pdf" | "xlsx";

/** Where a unit lives in the file — human-readable locator + machine address. */
export type FileUnitAddress = {
  /** Folder source: the unit's source file path, relative to the folder root. */
  path?: string;
  /** Prose: the section heading stack above this unit, e.g. ["Pricing", "Enterprise"]. */
  headingPath?: string[];
  /** Prose: 1-based source line number where this unit begins. */
  line?: number;
  /** Prose: the section's own number when the doc is numbered ("9" for "9. SQL Injection"). */
  sectionNumber?: string;
  /** Prose: index among paragraphs (within its page/section). */
  paragraphIndex?: number;
  /** PDF: 1-based page number. */
  page?: number;
  /** Tabular: source sheet name (XLSX). */
  sheet?: string;
  /** Tabular: 1-based data row index (excludes the header row). */
  rowIndex?: number;
  /** Tabular: header -> cell value for this row. */
  columns?: Record<string, string>;
};

/** Structural signals used to boost ranking. */
export type FileUnitStructure = {
  /** Prose: this unit is itself a heading line. */
  isHeading?: boolean;
  /** Tabular: the column header names for this unit's table. */
  headerColumns?: string[];
};

export type FileUnit = {
  /** Stable within a corpus: `${fileId}:u${ordinal}`. */
  id: string;
  /** Document order. Drives deterministic tie-breaking and neighbor pulling. */
  ordinal: number;
  kind: UnitKind;
  /** The searchable + returnable content. */
  text: string;
  address: FileUnitAddress;
  structure: FileUnitStructure;
  /**
   * Meaning-vector for semantic retrieval, computed once at ingest (Gemini).
   * Optional: corpora built before embeddings, or units ingested without an API
   * key, simply omit it and fall back to lexical ranking. See embeddingRanker.
   */
  embedding?: number[];
};

/**
 * Precomputed TF-IDF state. `tf` maps a unit id to its term-frequency map;
 * `df` is document frequency per term; `n` is the total unit count.
 */
export type CorpusIndex = {
  n: number;
  df: Record<string, number>;
  tf: Record<string, Record<string, number>>;
};

/** Whether the corpus was built from one file or a whole folder. */
export type CorpusSourceType = "file" | "folder";

/** Progress of a background folder ingest. */
export type CorpusProgress = {
  filesDone: number;
  filesTotal?: number;
};

export type FileCorpus = {
  fileId: string;
  /** Display name: the file name, or the folder root name for folder sources. */
  fileName: string;
  sourceType: CorpusSourceType;
  /** For single-file sources: the parsed file kind. Folder sources omit it. */
  sourceKind?: FileSourceKind;
  /** For folder sources: number of files ingested so far. */
  fileCount?: number;
  byteSize: number;
  ingestedAt: string;
  unitCount: number;
  /** True while a folder corpus is still trickling in the background. */
  building?: boolean;
  progress?: CorpusProgress;
  /** Non-fatal notes from ingest (e.g. unit cap reached). */
  warnings: string[];
  units: FileUnit[];
  index: CorpusIndex;
};

/**
 * The compact, self-describing summary of the active source that travels to the
 * model/pipeline — NOT the corpus itself (which stays in panel IndexedDB and is
 * queried lazily via the delegate). Represents a file or a folder.
 */
export type ActiveWorkingFileDescriptor = {
  fileName: string;
  sourceType: CorpusSourceType;
  sourceKind?: FileSourceKind;
  unitCount: number;
  fileCount?: number;
  building?: boolean;
  progress?: CorpusProgress;
  /** ISO timestamp of the last ingest — drives the "Updated Nm ago" tooltip. */
  ingestedAt?: string;
};

/** Natural-language phrase describing the attached source, for model prompts. */
export function describeActiveSource(source: ActiveWorkingFileDescriptor): string {
  if (source.sourceType === "folder") {
    const files = source.fileCount !== undefined ? `${source.fileCount} files, ` : "";
    const status = source.building ? ", still indexing in the background" : "";
    return `a folder "${source.fileName}" (${files}${source.unitCount} indexed units${status})`;
  }
  const kind = source.sourceKind ? `${source.sourceKind}, ` : "";
  return `a file "${source.fileName}" (${kind}${source.unitCount} indexed units)`;
}
