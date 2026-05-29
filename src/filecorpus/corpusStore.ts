/**
 * Persistence for the "work from a file" corpus, in panel-side IndexedDB.
 * Mirrors the workspaceStore IDB plumbing (open/upgrade, idbRequest, an
 * in-module cache, schema-version migrate-on-read).
 *
 * Two stores:
 *  - `corpus` (keyPath "fileId") holds full FileCorpus records.
 *  - `meta`   (keyPath "key")    holds one pointer record {key:"active", fileId}.
 *
 * v1 keeps ONE active working file but the schema is multi-file-capable (keyed
 * by fileId) so "many" is a later additive change.
 */

import type { ActiveWorkingFileDescriptor, FileCorpus } from "./corpusTypes";
import { embedUnits, type EmbedTexts } from "./embedUnits";

const DB_NAME = "ohmygod.filecorpus";
const DB_VERSION = 1;
const CORPUS_STORE = "corpus";
const META_STORE = "meta";
const ACTIVE_KEY = "active";
const SCHEMA_VERSION = 1;

type StoredCorpus = FileCorpus & { schemaVersion: number };
type ActivePointer = { key: typeof ACTIVE_KEY; fileId: string };

let cachedActiveCorpus: StoredCorpus | undefined;

/** Embedding coverage of a corpus — how many units carry a meaning-vector, and the vector size. */
export type CorpusEmbeddingStatus = {
  /** Units that have an embedding vector. */
  embeddedUnits: number;
  /** Vector dimension (0 when nothing is embedded yet). */
  dimensions: number;
};

export type ActiveCorpusStatus =
  | { active: false }
  | ({ active: true; embeddings: CorpusEmbeddingStatus } & ActiveWorkingFileDescriptor);

function isSupported(): boolean {
  return "indexedDB" in globalThis;
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(CORPUS_STORE)) {
      db.createObjectStore(CORPUS_STORE, { keyPath: "fileId" });
    }
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE, { keyPath: "key" });
    }
  };
  return idbRequest(request);
}

function migrate(record: StoredCorpus): StoredCorpus {
  // No migrations yet; stamp the current schema version for forward records.
  return record.schemaVersion === SCHEMA_VERSION ? record : { ...record, schemaVersion: SCHEMA_VERSION };
}

/** Persist a corpus. Does NOT mark it active — call setActiveCorpus for that. */
export async function putCorpus(corpus: FileCorpus): Promise<void> {
  if (!isSupported()) {
    throw new Error("This browser does not support storing a working file.");
  }
  const record: StoredCorpus = { ...corpus, schemaVersion: SCHEMA_VERSION };
  const db = await openDb();
  await idbRequest(db.transaction(CORPUS_STORE, "readwrite").objectStore(CORPUS_STORE).put(record));
  db.close();
  // Keep the cache fresh during a background folder trickle: each persisted
  // growth of the ACTIVE corpus must be what getActiveCorpus()/corpus_query see,
  // otherwise mid-build queries would only ever hit the stale first slice.
  if (cachedActiveCorpus?.fileId === corpus.fileId) {
    cachedActiveCorpus = record;
  }
}

export async function getCorpus(fileId: string): Promise<FileCorpus | undefined> {
  if (!isSupported()) {
    return undefined;
  }
  const db = await openDb();
  const record = await idbRequest<StoredCorpus | undefined>(
    db.transaction(CORPUS_STORE, "readonly").objectStore(CORPUS_STORE).get(fileId)
  );
  db.close();
  return record ? migrate(record) : undefined;
}

async function getActivePointer(db: IDBDatabase): Promise<ActivePointer | undefined> {
  return idbRequest<ActivePointer | undefined>(
    db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(ACTIVE_KEY)
  );
}

export async function getActiveCorpus(): Promise<FileCorpus | undefined> {
  if (cachedActiveCorpus) {
    return cachedActiveCorpus;
  }
  if (!isSupported()) {
    return undefined;
  }
  const db = await openDb();
  const pointer = await getActivePointer(db);
  if (!pointer?.fileId) {
    db.close();
    return undefined;
  }
  const record = await idbRequest<StoredCorpus | undefined>(
    db.transaction(CORPUS_STORE, "readonly").objectStore(CORPUS_STORE).get(pointer.fileId)
  );
  db.close();
  if (!record) {
    return undefined;
  }
  cachedActiveCorpus = migrate(record);
  return cachedActiveCorpus;
}

export async function setActiveCorpus(fileId: string): Promise<void> {
  if (!isSupported()) {
    throw new Error("This browser does not support storing a working file.");
  }
  const db = await openDb();
  const pointer: ActivePointer = { key: ACTIVE_KEY, fileId };
  await idbRequest(db.transaction(META_STORE, "readwrite").objectStore(META_STORE).put(pointer));
  db.close();
  cachedActiveCorpus = undefined; // force re-read on next getActiveCorpus
}

export async function clearActiveCorpus(): Promise<void> {
  cachedActiveCorpus = undefined;
  if (!isSupported()) {
    return;
  }
  const db = await openDb();
  await idbRequest(db.transaction(META_STORE, "readwrite").objectStore(META_STORE).delete(ACTIVE_KEY));
  db.close();
}

/** Lightweight status for the UI — does not load the full corpus into memory unnecessarily. */
export async function getActiveCorpusStatus(): Promise<ActiveCorpusStatus> {
  const corpus = await getActiveCorpus();
  if (!corpus) {
    return { active: false };
  }
  return { active: true, ...activeDescriptorFromCorpus(corpus), embeddings: embeddingStatusFromCorpus(corpus) };
}

/** Count embedded units + vector size, so the settings readout can show retrieval mode. */
export function embeddingStatusFromCorpus(corpus: FileCorpus): CorpusEmbeddingStatus {
  let embeddedUnits = 0;
  let dimensions = 0;
  for (const unit of corpus.units) {
    if (unit.embedding && unit.embedding.length) {
      embeddedUnits += 1;
      if (!dimensions) {
        dimensions = unit.embedding.length;
      }
    }
  }
  return { embeddedUnits, dimensions };
}

export function activeDescriptorFromCorpus(corpus: FileCorpus): ActiveWorkingFileDescriptor {
  return {
    fileName: corpus.fileName,
    sourceType: corpus.sourceType,
    sourceKind: corpus.sourceKind,
    unitCount: corpus.unitCount,
    fileCount: corpus.fileCount,
    building: corpus.building,
    progress: corpus.progress,
    ingestedAt: corpus.ingestedAt
  };
}

export type EmbedRemainingResult = {
  /** Units that gained a vector in this pass. */
  newlyEmbedded: number;
  /** Total embedded after the pass. */
  embeddedUnits: number;
  /** Total units in the corpus. */
  unitCount: number;
  warning?: string;
};

/**
 * Top up embedding coverage on the ACTIVE corpus: embed only the units still
 * missing a vector, then persist. Idempotent (embedUnits skips already-embedded
 * units), so it safely resumes after a throttle stall without a full reconnect.
 * Powers the "Embed remaining" button in settings.
 */
export async function embedRemainingActiveCorpus(embed: EmbedTexts): Promise<EmbedRemainingResult> {
  const corpus = await getActiveCorpus();
  if (!corpus) {
    return { newlyEmbedded: 0, embeddedUnits: 0, unitCount: 0 };
  }
  const before = embeddingStatusFromCorpus(corpus).embeddedUnits;
  const result = await embedUnits(corpus.units, embed);
  if (result.embedded > 0) {
    const next: FileCorpus = { ...corpus, units: result.units };
    await putCorpus(next);
  }
  const status = embeddingStatusFromCorpus({ ...corpus, units: result.units });
  return {
    newlyEmbedded: status.embeddedUnits - before,
    embeddedUnits: status.embeddedUnits,
    unitCount: corpus.unitCount,
    warning: result.warning
  };
}

/** Test seam: drop the in-module active-corpus cache. */
export function clearCorpusCache(): void {
  cachedActiveCorpus = undefined;
}
