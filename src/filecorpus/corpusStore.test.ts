import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveCorpus,
  clearCorpusCache,
  embedRemainingActiveCorpus,
  getActiveCorpus,
  getActiveCorpusStatus,
  getCorpus,
  putCorpus,
  setActiveCorpus
} from "./corpusStore";
import type { FileCorpus } from "./corpusTypes";

function makeCorpus(fileId: string, fileName: string): FileCorpus {
  return {
    fileId,
    fileName,
    sourceType: "file",
    sourceKind: "csv",
    byteSize: 10,
    ingestedAt: "2026-05-29T00:00:00.000Z",
    unitCount: 1,
    warnings: [],
    units: [
      { id: `${fileId}:u0`, ordinal: 0, kind: "row", text: "Name: Ada", address: {}, structure: {} }
    ],
    index: { n: 1, df: { ada: 1, name: 1 }, tf: { [`${fileId}:u0`]: { ada: 1, name: 1 } } }
  };
}

// Minimal in-memory IndexedDB supporting two keyed stores (corpus by fileId, meta by key).
function makeIndexedDb(): IDBFactory {
  const stores: Record<string, Map<string, unknown>> = {
    corpus: new Map(),
    meta: new Map()
  };

  const keyPathFor = (storeName: string) => (storeName === "corpus" ? "fileId" : "key");

  const deferred = <T>(result: T): IDBRequest<T> => {
    const request = { result, error: null, onsuccess: null as ((e: Event) => void) | null, onerror: null };
    queueMicrotask(() => request.onsuccess?.({} as Event));
    return request as unknown as IDBRequest<T>;
  };

  const makeDb = (): IDBDatabase =>
    ({
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({}),
      transaction: (storeName: string) => ({
        objectStore: () => {
          const map = stores[storeName];
          const key = keyPathFor(storeName);
          return {
            get: (id: string) => deferred(map.get(id)),
            put: (value: Record<string, string>) => {
              map.set(value[key], value);
              return deferred(undefined);
            },
            delete: (id: string) => {
              map.delete(id);
              return deferred(undefined);
            }
          };
        }
      }),
      close: () => undefined
    }) as unknown as IDBDatabase;

  return {
    open: () => {
      const request = { result: makeDb(), error: null, onsuccess: null, onerror: null, onupgradeneeded: null } as {
        result: IDBDatabase;
        error: null;
        onsuccess: ((e: Event) => void) | null;
        onerror: ((e: Event) => void) | null;
        onupgradeneeded: ((e: Event) => void) | null;
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.({} as Event);
        request.onsuccess?.({} as Event);
      });
      return request as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;
}

describe("corpusStore", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", makeIndexedDb());
    clearCorpusCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCorpusCache();
  });

  it("round-trips a corpus by fileId", async () => {
    const corpus = makeCorpus("c1", "people.csv");
    await putCorpus(corpus);
    const loaded = await getCorpus("c1");
    expect(loaded?.fileName).toBe("people.csv");
    expect(loaded?.index.n).toBe(1);
  });

  it("tracks the active pointer and resolves the active corpus", async () => {
    await putCorpus(makeCorpus("c1", "a.csv"));
    await putCorpus(makeCorpus("c2", "b.csv"));
    await setActiveCorpus("c2");

    const active = await getActiveCorpus();
    expect(active?.fileId).toBe("c2");

    const status = await getActiveCorpusStatus();
    expect(status).toMatchObject({ active: true, fileName: "b.csv", unitCount: 1 });
  });

  it("reports no active file before one is set and after clearing", async () => {
    expect(await getActiveCorpusStatus()).toEqual({ active: false });

    await putCorpus(makeCorpus("c1", "a.csv"));
    await setActiveCorpus("c1");
    expect((await getActiveCorpusStatus()).active).toBe(true);

    await clearActiveCorpus();
    expect(await getActiveCorpusStatus()).toEqual({ active: false });
  });

  it("switching the active pointer changes the resolved corpus (cache invalidates)", async () => {
    await putCorpus(makeCorpus("c1", "a.csv"));
    await putCorpus(makeCorpus("c2", "b.csv"));
    await setActiveCorpus("c1");
    expect((await getActiveCorpus())?.fileId).toBe("c1");
    await setActiveCorpus("c2");
    expect((await getActiveCorpus())?.fileId).toBe("c2");
  });

  it("reflects folder sourceType + building/progress in status", async () => {
    const folder: FileCorpus = {
      ...makeCorpus("fld", "my-project"),
      sourceType: "folder",
      sourceKind: undefined,
      fileCount: 40,
      building: true,
      progress: { filesDone: 40, filesTotal: 1200 }
    };
    await putCorpus(folder);
    await setActiveCorpus("fld");

    const status = await getActiveCorpusStatus();
    expect(status).toMatchObject({
      active: true,
      fileName: "my-project",
      sourceType: "folder",
      building: true,
      fileCount: 40,
      progress: { filesDone: 40, filesTotal: 1200 }
    });
  });

  it("keeps the active cache fresh as the trickle re-persists the same corpus", async () => {
    const initial: FileCorpus = { ...makeCorpus("fld", "proj"), sourceType: "folder", building: true, fileCount: 40 };
    await putCorpus(initial);
    await setActiveCorpus("fld");
    expect((await getActiveCorpus())?.fileCount).toBe(40); // populates cache

    // Trickle grows + re-persists the SAME fileId; status must reflect the growth.
    await putCorpus({ ...initial, fileCount: 1200, building: false, unitCount: 9000 });
    const grown = await getActiveCorpus();
    expect(grown?.fileCount).toBe(1200);
    expect(grown?.building).toBe(false);
  });

  it("embedRemainingActiveCorpus tops up only the un-embedded units and persists", async () => {
    const corpus: FileCorpus = {
      ...makeCorpus("topup", "proj"),
      unitCount: 2,
      units: [
        { id: "topup:u0", ordinal: 0, kind: "paragraph", text: "already", address: {}, structure: {}, embedding: [9, 9] },
        { id: "topup:u1", ordinal: 1, kind: "paragraph", text: "missing", address: {}, structure: {} }
      ]
    };
    await putCorpus(corpus);
    await setActiveCorpus("topup");

    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 1]));
    const result = await embedRemainingActiveCorpus(embed);

    expect(embed).toHaveBeenCalledWith(["missing"]); // already-embedded unit is not re-sent
    expect(result.newlyEmbedded).toBe(1);
    expect(result.embeddedUnits).toBe(2);
    expect(result.unitCount).toBe(2);

    // The persisted corpus now has both vectors.
    const reloaded = await getCorpus("topup");
    expect(reloaded?.units[0].embedding).toEqual([9, 9]);
    expect(reloaded?.units[1].embedding).toEqual([1, 1]);
  });

  it("embedRemainingActiveCorpus is a no-op with no active corpus", async () => {
    const embed = vi.fn(async () => []);
    const result = await embedRemainingActiveCorpus(embed);
    expect(embed).not.toHaveBeenCalled();
    expect(result).toEqual({ newlyEmbedded: 0, embeddedUnits: 0, unitCount: 0 });
  });
});
