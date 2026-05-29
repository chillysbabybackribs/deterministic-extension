import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../settings/settingsStore";
import {
  EmbeddingClientError,
  GEMINI_EMBEDDING_MODEL,
  embedQuery,
  embedTexts,
  hasGeminiApiKey
} from "./geminiEmbeddingClient";

afterEach(() => {
  vi.restoreAllMocks();
});

function settingsWithKey(key: string | undefined): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    provider: { ...DEFAULT_APP_SETTINGS.provider, geminiApiKey: key }
  } as AppSettings;
}

function embedResponse(vectors: number[][]): Response {
  return new Response(JSON.stringify({ embeddings: vectors.map((values) => ({ values })) }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("embedTexts", () => {
  it("returns [] for empty input without calling the network", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const out = await embedTexts({ settings: settingsWithKey("k"), texts: [] });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws missing_api_key when no Gemini key is set", async () => {
    await expect(embedTexts({ settings: settingsWithKey(""), texts: ["x"] })).rejects.toMatchObject({
      code: "missing_api_key"
    });
  });

  it("calls the Gemini batchEmbedContents endpoint with the key and returns index-aligned vectors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(embedResponse([[1, 0, 0], [0, 1, 0]]));

    const out = await embedTexts({ settings: settingsWithKey("secret"), texts: ["a", "b"] });

    expect(out).toEqual([[1, 0, 0], [0, 1, 0]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(GEMINI_EMBEDDING_MODEL);
    expect(String(url)).toContain("batchEmbedContents");
    expect(String(url)).toContain("key=secret");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("batches more than 100 inputs into multiple requests, preserving order", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { requests: unknown[] };
      // Echo back a distinct 1-dim vector per input so we can assert ordering.
      const vectors = body.requests.map((_, i) => [i]);
      return embedResponse(vectors);
    });

    const out = await embedTexts({ settings: settingsWithKey("k"), texts });

    expect(fetchMock).toHaveBeenCalledTimes(2); // 100 + 50
    expect(out).toHaveLength(150);
    // First batch was indices 0..99, second 0..49 (each batch self-indexes).
    expect(out[0]).toEqual([0]);
    expect(out[100]).toEqual([0]);
    expect(out[149]).toEqual([49]);
  });

  it("maps a persistent 429 to rate_limited after exhausting retries", async () => {
    // Fresh Response per call (the body is single-use; a shared instance would be
    // consumed after the first read).
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 })
    );
    await expect(
      embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: async () => undefined })
    ).rejects.toMatchObject({ code: "rate_limited", message: "quota exceeded" });
  });

  it("maps a persistently thrown fetch to a network_error after retries", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(
      embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: async () => undefined })
    ).rejects.toBeInstanceOf(EmbeddingClientError);
  });

  it("throws empty_response when the vector count does not match the input count", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(embedResponse([[1, 2, 3]]));
    await expect(embedTexts({ settings: settingsWithKey("k"), texts: ["a", "b"] })).rejects.toMatchObject({
      code: "empty_response"
    });
  });
});

describe("embedQuery", () => {
  it("returns the single query vector", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(embedResponse([[0.1, 0.2]]));
    const vec = await embedQuery({ settings: settingsWithKey("k"), text: "how is auth handled" });
    expect(vec).toEqual([0.1, 0.2]);
  });
});

describe("embedTexts concurrency + dimensions", () => {
  it("runs batches concurrently and still returns vectors in input order", async () => {
    // 250 texts -> 3 batches (100,100,50). Resolve them out of order; result must
    // still be index-aligned to the inputs.
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(String((init as RequestInit).body)) as { requests: { content: { parts: { text: string }[] } }[] };
      // Vector encodes the source text's numeric suffix so we can verify ordering.
      const vectors = body.requests.map((r) => [Number(r.content.parts[0].text.slice(1))]);
      await Promise.resolve();
      inFlight -= 1;
      return embedResponse(vectors);
    });

    const out = await embedTexts({ settings: settingsWithKey("k"), texts, concurrency: 3 });

    expect(out).toHaveLength(250);
    expect(out[0]).toEqual([0]);
    expect(out[150]).toEqual([150]);
    expect(out[249]).toEqual([249]);
    expect(maxInFlight).toBeGreaterThan(1); // proves concurrency actually overlapped
  });

  it("requests the configured output dimensionality", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(embedResponse([[1, 2]]));
    await embedTexts({ settings: settingsWithKey("k"), texts: ["x"] });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      requests: { outputDimensionality: number }[];
    };
    expect(body.requests[0].outputDimensionality).toBe(1536);
  });
});

describe("embedTexts retry/backoff", () => {
  const noSleep = async () => undefined;

  it("retries a 429 with backoff and succeeds (the fix for embedding dying at a throttle)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return embedResponse([[1, 2, 3]]);
    });
    const out = await embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: noSleep });
    expect(out).toEqual([[1, 2, 3]]);
    expect(calls).toBe(2); // one throttle, one success
  });

  it("retries 5xx then gives up as rate_limited/api_error after MAX_RETRIES", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 })
    );
    await expect(
      embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: noSleep })
    ).rejects.toMatchObject({ code: "api_error" });
  });

  it("honors a Retry-After header (does not throw, retries and succeeds)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
      }
      return embedResponse([[1]]);
    });
    await embedTexts({
      settings: settingsWithKey("k"),
      texts: ["x"],
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    expect(sleeps).toContain(2000); // 2s from Retry-After
  });

  it("does NOT retry a 4xx bad-request/key error (fails fast)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 });
    });
    await expect(
      embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: noSleep })
    ).rejects.toMatchObject({ code: "api_error" });
    expect(calls).toBe(1); // no retry on a hard 4xx
  });

  it("retries a transient network error", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
      return embedResponse([[7]]);
    });
    const out = await embedTexts({ settings: settingsWithKey("k"), texts: ["x"], sleep: noSleep });
    expect(out).toEqual([[7]]);
    expect(calls).toBe(2);
  });
});

describe("hasGeminiApiKey", () => {
  it("is true only when a non-empty key is set", () => {
    expect(hasGeminiApiKey(settingsWithKey("k"))).toBe(true);
    expect(hasGeminiApiKey(settingsWithKey(""))).toBe(false);
    expect(hasGeminiApiKey(settingsWithKey(undefined))).toBe(false);
  });
});
