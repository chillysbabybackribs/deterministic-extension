/**
 * Ingest a whole folder into ONE corpus, reusing the single-file parsers.
 *
 * Strategy (panel-side): ingest a CONSERVATIVE FIRST SLICE synchronously so the
 * chat is usable immediately, then TRICKLE the remaining files in the background
 * — extending the index in place (no full rebuild), yielding between batches so
 * the panel thread never blocks, persisting periodically (durable + queryable as
 * it grows), and aborting cleanly if the source is switched.
 *
 * Input is a list of already-read text files (see collectWorkspaceTextFiles in
 * workspaceStore), so this module is handle-free and unit-testable.
 */

import { makeId } from "../shared/id";
import type { FileCorpus, FileUnit } from "./corpusTypes";
import { MAX_UNITS, MAX_UNIT_CHARS, parseTextContentToUnits } from "./ingest";
import { buildIndex, extendIndex } from "./rankUnits";
import { embedUnits, type EmbedTexts } from "./embedUnits";
import { applyReusedEmbeddings, type EmbeddingReuseIndex } from "./reuseEmbeddings";
import { EMBEDDING_DIMENSIONS } from "../embeddings/geminiEmbeddingClient";

export type FolderTextFile = { path: string; name: string; text: string };

/** First-slice + trickle tuning. */
const INITIAL_FILES = 40;
const INITIAL_UNITS = 4_000;
const TRICKLE_BATCH_FILES = 10;
const PERSIST_EVERY_FILES = 50;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Parse one folder file into FileUnits tagged with its path. Units get globally
 * unique ids via the running `nextOrdinal` counter so the corpus index keys stay
 * distinct across files.
 */
function unitsForFile(
  fileId: string,
  file: FolderTextFile,
  startOrdinal: number
): FileUnit[] {
  const parsed = parseTextContentToUnits(file.name, file.text);
  return parsed.units.map((unit, i) => {
    const ordinal = startOrdinal + i;
    return {
      id: `${fileId}:u${ordinal}`,
      ordinal,
      kind: unit.kind,
      text: unit.text.length > MAX_UNIT_CHARS ? unit.text.slice(0, MAX_UNIT_CHARS) : unit.text,
      address: { ...unit.address, path: file.path },
      structure: unit.structure
    };
  });
}

export type IngestFolderArgs = {
  files: FolderTextFile[];
  rootName: string;
  /** Extra warnings from the file collection step (e.g. truncation). */
  collectionWarnings?: string[];
  signal?: AbortSignal;
  /** Called with the growing corpus when it should be persisted + reflected in UI. */
  onUpdate?: (corpus: FileCorpus) => void | Promise<void>;
  /**
   * Injected batch embedder; when present, units get meaning-vectors as they
   * trickle in, so semantic search becomes available as the folder fills. The
   * initial slice is embedded synchronously so the first query is semantic too.
   */
  embed?: EmbedTexts;
  /** Prior embeddings to reuse for unchanged content (skips re-embedding on reconnect). */
  reuse?: EmbeddingReuseIndex;
};

/**
 * Build the first slice synchronously and return it immediately, then continue
 * trickling. Returns the INITIAL corpus; the full build completes via repeated
 * `onUpdate` calls. The returned promise's `done` resolves when the whole folder
 * is ingested (or aborted).
 */
export async function ingestFolder(args: IngestFolderArgs): Promise<{ initial: FileCorpus; done: Promise<FileCorpus> }> {
  const fileId = makeId("corpus");
  const warnings = [...(args.collectionWarnings ?? [])];
  const files = args.files;

  const units: FileUnit[] = [];
  let fileCursor = 0;
  let unitsCapped = false;

  const ingestNextFile = (): number => {
    if (fileCursor >= files.length || units.length >= MAX_UNITS) {
      if (units.length >= MAX_UNITS && !unitsCapped) {
        unitsCapped = true;
        warnings.push(`Folder exceeded ${MAX_UNITS.toLocaleString()} units; the rest was not indexed.`);
      }
      return 0;
    }
    const file = files[fileCursor];
    fileCursor += 1;
    const fileUnits = unitsForFile(fileId, file, units.length);
    units.push(...fileUnits);
    return fileUnits.length;
  };

  let embedWarned = false;
  // Embed the units in [from, units.length) and write vectors back into the live
  // array in place. Reused vectors (unchanged content from a prior corpus) are
  // applied first and cost no API call; only the remainder hit the embedder.
  // Never throws — a failed/absent embedder leaves units lexical and records one
  // warning. Keeps the trickle resilient batch-to-batch.
  const embedRange = async (from: number): Promise<void> => {
    if (from >= units.length) {
      return;
    }
    const slice = units.slice(from);
    // Reuse first — fills vectors for unchanged units, even when no embedder is set.
    const { units: seeded } = applyReusedEmbeddings(slice, args.reuse, EMBEDDING_DIMENSIONS);
    const result = args.embed ? await embedUnits(seeded, args.embed) : { units: seeded, embedded: 0, warning: undefined };
    for (let i = 0; i < slice.length; i += 1) {
      const vector = result.units[i].embedding;
      if (vector) {
        units[from + i] = { ...units[from + i], embedding: vector };
      }
    }
    if (result.warning && !embedWarned) {
      embedWarned = true;
      warnings.push(result.warning);
    }
  };

  const makeCorpus = (building: boolean): FileCorpus => ({
    fileId,
    fileName: args.rootName,
    sourceType: "folder",
    fileCount: fileCursor,
    byteSize: 0,
    ingestedAt: new Date().toISOString(),
    unitCount: units.length,
    building,
    progress: { filesDone: fileCursor, filesTotal: files.length },
    warnings,
    units,
    index: buildIndex(units)
  });

  // FIRST SLICE — synchronous, small, so chat works at once.
  while (
    fileCursor < files.length &&
    fileCursor < INITIAL_FILES &&
    units.length < INITIAL_UNITS &&
    units.length < MAX_UNITS
  ) {
    ingestNextFile();
  }
  // Embed the first slice before snapshotting so the very first query is semantic.
  await embedRange(0);
  // The returned `initial` is a STABLE SNAPSHOT of the first slice (its own units
  // array + index), so callers can read it without it mutating under them while
  // the trickle grows the live corpus below.
  const initialSnapshot: FileCorpus = { ...makeCorpus(fileCursor < files.length), units: units.slice() };
  initialSnapshot.index = buildIndex(initialSnapshot.units);

  // TRICKLE — build the full corpus on the LIVE units/index in the background.
  const done = (async (): Promise<FileCorpus> => {
    const corpus = makeCorpus(fileCursor < files.length);
    corpus.units = units; // live array the trickle appends to
    let sincePersist = 0;
    while (fileCursor < files.length && units.length < MAX_UNITS) {
      if (args.signal?.aborted) {
        break;
      }
      const batchStart = units.length;
      for (let i = 0; i < TRICKLE_BATCH_FILES && fileCursor < files.length && units.length < MAX_UNITS; i += 1) {
        const before = units.length;
        ingestNextFile();
        extendIndex(corpus.index, units.slice(before));
        sincePersist += 1;
      }
      // Embed the units added this batch (in place on the live array) so vectors
      // fill in alongside the index as the folder trickles in.
      await embedRange(batchStart);
      corpus.unitCount = units.length;
      corpus.fileCount = fileCursor;
      corpus.progress = { filesDone: fileCursor, filesTotal: files.length };
      corpus.building = fileCursor < files.length && !args.signal?.aborted;
      if (sincePersist >= PERSIST_EVERY_FILES || !corpus.building) {
        sincePersist = 0;
        await args.onUpdate?.(corpus);
      }
      await yieldToEventLoop();
    }
    corpus.building = false;
    corpus.progress = { filesDone: fileCursor, filesTotal: files.length };
    await args.onUpdate?.(corpus);
    return corpus;
  })();

  return { initial: initialSnapshot, done };
}

/**
 * Owns the single active background trickle so a new attach/refresh aborts the
 * previous run (abort-on-switch). One controller per panel.
 */
export class TrickleController {
  private current?: AbortController;

  start(): AbortSignal {
    this.current?.abort();
    this.current = new AbortController();
    return this.current.signal;
  }

  abort(): void {
    this.current?.abort();
    this.current = undefined;
  }
}
