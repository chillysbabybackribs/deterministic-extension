import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebCorpus, listWebCorpusDescriptors, writePage } from "./webCorpusStore";
import type { PageEntry } from "./webCorpusTypes";

function page(pageId: string, componentCount: number): PageEntry {
  return {
    pageId,
    title: "T",
    lastUrl: pageId,
    capturedAt: "2026-05-29T00:00:00.000Z",
    visitCount: 0,
    components: Array.from({ length: componentCount }, (_, i) => ({
      id: `${pageId}#c${i}`,
      ordinal: i,
      behaviorKey: `flat:${i}`,
      instanceCount: 1,
      kind: "button" as const,
      region: "unknown" as const,
      name: `c${i}`,
      searchText: `c${i}`
    })),
    contentSections: [],
    rawElementCount: componentCount,
    dedupedCount: 0,
    warnings: []
  };
}

// Minimal in-memory IndexedDB with a single "sites" store keyed by siteId.
function makeIndexedDb(): IDBFactory {
  const store = new Map<string, unknown>();
  const deferred = <T>(result: T): IDBRequest<T> => {
    const request = { result, error: null, onsuccess: null as ((e: Event) => void) | null, onerror: null };
    queueMicrotask(() => request.onsuccess?.({} as Event));
    return request as unknown as IDBRequest<T>;
  };
  const makeDb = (): IDBDatabase =>
    ({
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({}),
      transaction: () => ({
        objectStore: () => ({
          get: (id: string) => deferred(store.get(id)),
          getAll: () => deferred([...store.values()]),
          put: (value: Record<string, string>) => {
            store.set(value.siteId, value);
            return deferred(undefined);
          }
        })
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

describe("webCorpusStore", () => {
  beforeEach(() => vi.stubGlobal("indexedDB", makeIndexedDb()));
  afterEach(() => vi.unstubAllGlobals());

  it("creates a site corpus on first write", async () => {
    const desc = await writePage({
      siteId: "https://shop.test",
      siteName: "shop.test",
      page: page("https://shop.test/a", 3),
      now: "2026-05-29T01:00:00.000Z"
    });
    expect(desc).toMatchObject({ siteName: "shop.test", pageCount: 1, componentCount: 3 });

    const corpus = await getWebCorpus("https://shop.test");
    expect(corpus?.pages["https://shop.test/a"].visitCount).toBe(1);
    expect(corpus?.createdAt).toBe("2026-05-29T01:00:00.000Z");
    // The retrieval index is built on write over all components (3 here).
    expect(corpus?.index.n).toBe(3);
  });

  it("accumulates distinct pages across writes", async () => {
    await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: page("https://shop.test/a", 2), now: "t1" });
    const desc = await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: page("https://shop.test/b", 4), now: "t2" });
    expect(desc.pageCount).toBe(2);
    expect(desc.componentCount).toBe(6);
  });

  it("lists per-page detail with exact urls, newest first", async () => {
    const a = { ...page("https://shop.test/a", 2), lastUrl: "https://shop.test/a?ref=1", title: "A" };
    const b = { ...page("https://shop.test/b", 4), lastUrl: "https://shop.test/b#x", title: "B" };
    await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: a, now: "2026-05-29T01:00:00.000Z" });
    await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: b, now: "2026-05-29T02:00:00.000Z" });

    const [site] = await listWebCorpusDescriptors();
    expect(site.pages).toHaveLength(2);
    // newest capture first
    expect(site.pages![0].lastUrl).toBe("https://shop.test/b#x");
    expect(site.pages![0].componentCount).toBe(4);
    expect(site.pages![1].lastUrl).toBe("https://shop.test/a?ref=1");
  });

  it("a revisit replaces the page and bumps visitCount", async () => {
    await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: page("https://shop.test/a", 2), now: "t1" });
    await writePage({ siteId: "https://shop.test", siteName: "shop.test", page: page("https://shop.test/a", 5), now: "t2" });
    const corpus = await getWebCorpus("https://shop.test");
    expect(corpus?.pageCount).toBe(1);
    expect(corpus?.pages["https://shop.test/a"].visitCount).toBe(2);
    expect(corpus?.pages["https://shop.test/a"].components).toHaveLength(5);
    expect(corpus?.updatedAt).toBe("t2");
  });
});
