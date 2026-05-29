/**
 * Gemini embedding client — turns text into meaning-vectors.
 *
 * This is the front end of the deterministic retrieval pipeline: every corpus
 * chunk is embedded once at ingest, the natural-language prompt is embedded the
 * same way at query time, and retrieval is a cosine nearest-neighbour lookup
 * (see embeddingRanker). The model is never in the retrieval loop — it only sees
 * the organised, deduped summary the pipeline produces afterwards.
 *
 * Mirrors the direct-from-runtime pattern of anthropicToolClient: the API key
 * lives in settings (provider.geminiApiKey) and we call the Gemini REST endpoint
 * straight from the extension — no backend. Errors carry a typed code so callers
 * can degrade gracefully (e.g. fall back to lexical ranking) instead of throwing
 * into the pipeline.
 *
 * Pure transport: no corpus types here, just text -> vectors. Batched, because a
 * folder ingest embeds many units at once.
 */

import type { AppSettings } from "../settings/settingsStore";

/** The Gemini embedding model. General-purpose, content-agnostic (text / code / prose / tabular). */
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

const GEMINI_EMBED_URL = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;

/** Max texts per request — Gemini's batchEmbedContents accepts up to 100 contents. */
const MAX_BATCH = 100;

/**
 * Output vector size. Gemini's default is 3072; via Matryoshka (MRL) we request
 * 1536 at the SAME price — half the IndexedDB storage and faster cosine scans
 * with negligible quality loss (Google's own guidance lists 1536 as a
 * highest-quality option). Query and corpus MUST use the same value to stay in
 * one comparable vector space.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Retry/backoff tuning for transient throttling (429) and server errors (5xx). */
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * How many batch requests run at once. On a paid tier (150+ RPM) this overlaps
 * the round-trips instead of waiting for each, turning a minutes-long ingest into
 * seconds. Kept modest so it stays well under the rate limit; backoff covers any
 * 429 if a burst still trips it.
 */
const MAX_CONCURRENT_BATCHES = 5;

export class EmbeddingClientError extends Error {
  constructor(
    public readonly code: "missing_api_key" | "network_error" | "api_error" | "rate_limited" | "empty_response",
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "EmbeddingClientError";
  }
}

/** Injectable sleep so tests don't actually wait. Defaults to a real timer. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type EmbedArgs = {
  settings: AppSettings;
  /** The texts to embed, in order. The returned vectors line up 1:1 with this array. */
  texts: string[];
  /** Override the embedding model (defaults to GEMINI_EMBEDDING_MODEL). */
  model?: string;
  signal?: AbortSignal;
  /** Injectable sleep (tests pass a no-op so backoff/pacing don't actually wait). */
  sleep?: Sleep;
  /** Concurrent in-flight batches (defaults to MAX_CONCURRENT_BATCHES). */
  concurrency?: number;
};

/**
 * Embed an ordered list of texts into vectors. The result is index-aligned with
 * `texts` (result[i] is the vector for texts[i]). Empty input returns []. Splits
 * into MAX_BATCH-sized requests and runs up to MAX_CONCURRENT_BATCHES of them
 * CONCURRENTLY (the big speed win on a paid tier), each RETRYING with exponential
 * backoff on 429/5xx so a large ingest finishes instead of dying at a throttle.
 * Output order is preserved regardless of which batch finishes first.
 */
export async function embedTexts(args: EmbedArgs): Promise<number[][]> {
  const texts = args.texts;
  if (!texts.length) {
    return [];
  }
  const apiKey = requireGeminiApiKey(args.settings);
  const model = args.model ?? GEMINI_EMBEDDING_MODEL;
  const sleep = args.sleep ?? realSleep;
  const concurrency = Math.max(1, args.concurrency ?? MAX_CONCURRENT_BATCHES);

  // Slice into ordered batches; each batch records its destination offset so we
  // can write results back in order even though they complete out of order.
  type Batch = { offset: number; texts: string[] };
  const batches: Batch[] = [];
  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    batches.push({ offset: start, texts: texts.slice(start, start + MAX_BATCH) });
  }

  const vectors: number[][] = new Array(texts.length);
  let next = 0;
  let firstError: unknown;

  // A fixed pool of workers each pull the next batch until the queue drains. The
  // first error is captured and re-thrown after the pool unwinds, so we don't
  // leave dangling in-flight requests on failure.
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = next;
      if (index >= batches.length) {
        return;
      }
      next += 1;
      const batch = batches[index];
      try {
        const batchVectors = await embedBatch(batch.texts, apiKey, model, sleep, args.signal);
        for (let i = 0; i < batchVectors.length; i += 1) {
          vectors[batch.offset + i] = batchVectors[i];
        }
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));

  if (firstError !== undefined) {
    throw firstError;
  }
  return vectors;
}

/** Embed a single text into one vector. Convenience for the query side. */
export async function embedQuery(args: Omit<EmbedArgs, "texts"> & { text: string }): Promise<number[]> {
  const [vector] = await embedTexts({ ...args, texts: [args.text] });
  if (!vector) {
    throw new EmbeddingClientError("empty_response", "Gemini returned no embedding for the query.");
  }
  return vector;
}

/** True when a Gemini API key is configured — callers use this to decide whether to embed at all. */
export function hasGeminiApiKey(settings: AppSettings): boolean {
  return Boolean(settings.provider.geminiApiKey?.trim());
}

async function embedBatch(
  batch: string[],
  apiKey: string,
  model: string,
  sleep: Sleep,
  signal?: AbortSignal
): Promise<number[][]> {
  const body = {
    requests: batch.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS
    }))
  };

  let lastError: EmbeddingClientError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) {
      throw new EmbeddingClientError("network_error", "Embedding aborted.");
    }

    let response: Response;
    try {
      response = await fetch(`${GEMINI_EMBED_URL(model)}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      // Network blips are transient — retry them too.
      lastError = new EmbeddingClientError(
        "network_error",
        error instanceof Error ? error.message : "Network error while calling Gemini embeddings.",
        error
      );
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    // 429 (rate limit) and 5xx (server) are transient — back off and retry,
    // honoring Retry-After when the server sends it. This is the fix for
    // embedding dying partway through a large ingest.
    if (response.status === 429 || response.status >= 500) {
      const json = await safeReadJson(response);
      const apiError = isRecord(json) && isRecord(json.error) ? json.error : undefined;
      const message =
        typeof apiError?.message === "string"
          ? apiError.message
          : `Gemini embeddings returned HTTP ${response.status}.`;
      lastError = new EmbeddingClientError(response.status === 429 ? "rate_limited" : "api_error", message, json);
      if (attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        await sleep(retryAfter ?? backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const json = await safeReadJson(response);
    if (!response.ok) {
      const apiError = isRecord(json) && isRecord(json.error) ? json.error : undefined;
      const message =
        typeof apiError?.message === "string" ? apiError.message : `Gemini embeddings returned HTTP ${response.status}.`;
      throw new EmbeddingClientError("api_error", message, json); // 4xx (bad key/request) — not retryable.
    }

    const vectors = parseEmbeddings(json);
    if (vectors.length !== batch.length) {
      throw new EmbeddingClientError(
        "empty_response",
        `Gemini returned ${vectors.length} embeddings for ${batch.length} inputs.`,
        json
      );
    }
    return vectors;
  }

  // Exhausted retries.
  throw lastError ?? new EmbeddingClientError("api_error", "Gemini embeddings failed after retries.");
}

/** Exponential backoff with full jitter-free cap. attempt is 0-based. */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Parse a Retry-After header (seconds or HTTP-date) into ms; undefined when absent/unusable. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
  }
  return undefined;
}

/** Parse the `{ embeddings: [{ values: number[] }] }` batch response shape. */
function parseEmbeddings(json: unknown): number[][] {
  if (!isRecord(json) || !Array.isArray(json.embeddings)) {
    return [];
  }
  const vectors: number[][] = [];
  for (const entry of json.embeddings) {
    const values = isRecord(entry) ? entry.values : undefined;
    if (Array.isArray(values) && values.every((v) => typeof v === "number")) {
      vectors.push(values as number[]);
    }
  }
  return vectors;
}

function requireGeminiApiKey(settings: AppSettings): string {
  const apiKey = settings.provider.geminiApiKey?.trim();
  if (!apiKey) {
    throw new EmbeddingClientError(
      "missing_api_key",
      "Add a Gemini API key in settings to enable semantic corpus search."
    );
  }
  return apiKey;
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
