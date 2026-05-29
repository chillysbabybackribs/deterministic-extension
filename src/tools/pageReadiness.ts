import { delay } from "../shared/asyncUtils";
import { waitForTabComplete } from "./chromeTabs";

export type PageReadinessOptions = {
  timeoutMs?: number;
  pollMs?: number;
  minWaitMs?: number;
  /** Number of consecutive unchanged samples required after minWaitMs. */
  stableSampleCount?: number;
  /** Optional extra wall-clock stable window for high-risk reads. */
  stableWindowMs?: number;
  reason?: string;
};

export type PageReadinessSample = {
  href: string;
  title: string;
  readyState: DocumentReadyState;
  textLength: number;
  textHash: number;
  elementCount: number;
  resourceCount: number;
  busyCount: number;
};

export type PageReadinessResult = {
  ok: boolean;
  elapsedMs: number;
  samples: number;
  reason: string;
  warnings: string[];
  lastSample?: PageReadinessSample;
};

const DEFAULT_TIMEOUT_MS = 4_500;
const DEFAULT_POLL_MS = 200;
const DEFAULT_MIN_WAIT_MS = 350;
const DEFAULT_STABLE_SAMPLE_COUNT = 2;

export async function waitForPageReadyForExtraction(
  tabId: number | undefined,
  options: PageReadinessOptions = {}
): Promise<PageReadinessResult> {
  const started = Date.now();
  const timeoutMs = clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 30_000);
  const pollMs = clamp(options.pollMs, DEFAULT_POLL_MS, 50, 2_000);
  const minWaitMs = clamp(options.minWaitMs, DEFAULT_MIN_WAIT_MS, 0, timeoutMs);
  const stableSampleCount = clamp(options.stableSampleCount, DEFAULT_STABLE_SAMPLE_COUNT, 1, 10);
  const stableWindowMs = options.stableWindowMs === undefined
    ? undefined
    : clamp(options.stableWindowMs, 0, 0, timeoutMs);
  const reason = options.reason ?? "page extraction";
  const resolvedTabId = tabId ?? await activeTabId();

  if (resolvedTabId === undefined) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      samples: 0,
      reason,
      warnings: [`Skipped page-readiness wait for ${reason}: no active tab id was available.`]
    };
  }

  await waitForTabComplete(resolvedTabId, Math.min(timeoutMs, 4_000)).catch(() => undefined);

  let lastSignature = "";
  let stableSince: number | undefined;
  let consecutiveStableSamples = 0;
  let samples = 0;
  let lastSample: PageReadinessSample | undefined;

  while (Date.now() - started < timeoutMs) {
    try {
      const sample = await samplePageReadiness(resolvedTabId);
      samples += 1;
      lastSample = sample;
      const now = Date.now();
      const signature = pageReadinessSignature(sample);
      const readyEnough = sample.readyState === "complete" || (sample.readyState === "interactive" && now - started >= minWaitMs);
      const stable = signature === lastSignature;

      if (readyEnough && stable) {
        stableSince ??= now;
        consecutiveStableSamples += 1;
      } else {
        stableSince = undefined;
        consecutiveStableSamples = 0;
      }

      if (
        stableSince !== undefined &&
        consecutiveStableSamples >= stableSampleCount &&
        (stableWindowMs === undefined || now - stableSince >= stableWindowMs) &&
        now - started >= minWaitMs
      ) {
        return {
          ok: true,
          elapsedMs: now - started,
          samples,
          reason,
          warnings: [],
          lastSample
        };
      }

      lastSignature = signature;
    } catch {
      stableSince = undefined;
      consecutiveStableSamples = 0;
      lastSignature = "";
    }

    await delay(pollMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - started,
    samples,
    reason,
    warnings: [`Page readiness for ${reason} did not fully settle within ${timeoutMs}ms; extracting the best available current state.`],
    lastSample
  };
}

export function pageReadinessSignature(sample: PageReadinessSample): string {
  return [
    sample.href,
    sample.title,
    sample.readyState,
    sample.textLength,
    sample.textHash,
    sample.elementCount,
    sample.resourceCount,
    sample.busyCount
  ].join("|");
}

async function activeTabId(): Promise<number | undefined> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return active?.id;
}

async function samplePageReadiness(tabId: number): Promise<PageReadinessSample> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: collectPageReadinessSample
  });
  if (!result?.result) {
    throw new Error("Page-readiness sample returned no result.");
  }
  return result.result;
}

function collectPageReadinessSample(): PageReadinessSample {
  const text = (document.body?.innerText ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120_000);
  const busyCount = document.querySelectorAll([
    '[aria-busy="true"]',
    '[aria-live][aria-busy="true"]',
    '[role="progressbar"]',
    '[role="status"][aria-busy="true"]',
    '[data-loading="true"]',
    '[data-pending="true"]'
  ].join(",")).length;

  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    textLength: text.length,
    textHash: hashText(text),
    elementCount: document.getElementsByTagName("*").length,
    resourceCount: performance.getEntriesByType("resource").length,
    busyCount
  };

  function hashText(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
