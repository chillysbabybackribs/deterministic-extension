/**
 * browser_capture_network tool implementation (slice 1).
 *
 * Actions:
 *   - start    Attach capture to a tab (page shim by default; CDP only in
 *              builds that explicitly enable it and declare debugger as a
 *              required permission). CDP shows Chrome's visible debugging
 *              banner while active.
 *   - stop     Detach and keep the buffer for a final summary/dump.
 *   - summary  Compact, model-friendly aggregate (default payload).
 *   - dump     Raw captured requests/frames, filtered, un-redacted. Sensitive
 *              values are tagged in the summary so the cost of a dump is visible.
 *
 * This module is source-agnostic: it talks to the shared captureBuffer and the
 * CDP source. The MAIN-world page-shim fallback plugs in here later behind the
 * same start/stop without changing the tool contract.
 */

import {
  buildSummary,
  clearBuffer,
  createBuffer,
  getBuffer,
  type CaptureSummary,
  type CapturedRequest
} from "./captureBuffer";
import {
  hasDebuggerPermission,
  isCdpCapturing,
  startCdpCapture,
  stopCdpCapture
} from "./cdpCapture";
import {
  isPageShimCapturing,
  startPageShimCapture,
  stopPageShimCapture
} from "./pageShimCapture";
import {
  isWebRequestCapturing,
  startWebRequestCapture,
  stopWebRequestCapture
} from "./webRequestCapture";

/**
 * Off-by-default opt-in for the chrome.debugger/CDP network source. The shim is
 * the default; CDP must never be auto-selected. Set to true only for an explicit
 * deeper-capture build after declaring "debugger" in required manifest
 * permissions. Chrome does not allow "debugger" in optional_permissions.
 */
const ENABLE_CDP_NETWORK_CAPTURE = false;

/** True when ANY capture source is live on the tab. */
function isCapturing(tabId: number): boolean {
  return isCdpCapturing(tabId) || isPageShimCapturing(tabId) || isWebRequestCapturing(tabId);
}

export type CaptureAction = "start" | "stop" | "summary" | "dump";

export type CaptureToolInput = {
  action: CaptureAction;
  tabId: number;
  urlIncludes?: string;
  methods?: string[];
  onlySensitive?: boolean;
  includeBodies?: boolean;
  maxRequests?: number;
};

export type CaptureToolResult = {
  action: CaptureAction;
  tabId: number;
  capturing: boolean;
  source: "cdp" | "page-shim" | "web-request" | "none";
  summary?: CaptureSummary;
  requests?: CapturedRequest[];
  warnings: string[];
  message: string;
};

export async function runCaptureNetwork(input: CaptureToolInput): Promise<CaptureToolResult> {
  switch (input.action) {
    case "start":
      return startCapture(input.tabId);
    case "stop":
      return stopCapture(input.tabId);
    case "summary":
      return summarize(input.tabId);
    case "dump":
      return dump(input);
    default:
      throw new Error(`Unsupported capture action: ${String(input.action)}`);
  }
}

async function startCapture(tabId: number): Promise<CaptureToolResult> {
  if (isCapturing(tabId)) {
    return {
      action: "start",
      tabId,
      capturing: true,
      source: isCdpCapturing(tabId) ? "cdp" : isPageShimCapturing(tabId) ? "page-shim" : "web-request",
      warnings: [],
      message: `Network capture already active on tab ${tabId}.`
    };
  }

  // The MAIN-world page shim is the primary, in-context network source: it needs
  // no permission, shows no Chrome banner, and (registered at document_start) sees
  // requests from page load onward. The chrome.debugger/CDP path is richer (opaque
  // cross-origin bodies, pre-shim requests) but is NEVER auto-selected — it is
  // gated behind ENABLE_CDP_NETWORK_CAPTURE, which defaults to false. Flipping it
  // on is an explicit opt-in; with no flags set, chrome.debugger is never attached.
  if (ENABLE_CDP_NETWORK_CAPTURE) {
    if (await hasDebuggerPermission()) {
      try {
        await startCdpCapture(tabId);
        return {
          action: "start",
          tabId,
          capturing: true,
          source: "cdp",
          warnings: [],
          message:
            `Network capture started on tab ${tabId} (CDP). Chrome shows a "debugging this browser" banner while active. ` +
            "Reload the page to capture requests made during load, then call summary."
        };
      } catch (error) {
        // Fall through to the page shim (e.g. DevTools already attached).
        return startWithPageShim(tabId, [
          error instanceof Error
            ? `CDP attach failed (${error.message}); using the page-shim fallback.`
            : "CDP attach failed; using the page-shim fallback."
        ]);
      }
    }
  }

  return startWithPageShim(tabId, []);
}

async function startWithPageShim(tabId: number, warnings: string[]): Promise<CaptureToolResult> {
  // The buffer is shared by both no-banner sources. Create it FIRST so the
  // webRequest listeners (which gate on getBuffer + activeTabs) have a target,
  // then start the CSP-proof webRequest spine, then inject the enrichment shim.
  if (!getBuffer(tabId)) {
    createBuffer(tabId, "web-request");
  }

  // webRequest is the authoritative inventory: it sees every request at the
  // network layer regardless of the page's CSP, so even on strict-CSP sites the
  // endpoint map is captured. It never throws on start (listener registration is
  // synchronous + idempotent).
  startWebRequestCapture(tabId);

  // The MAIN-world shim enriches entries with response bodies + WebSocket frame
  // payloads where the page CSP allows it to run. A blocked shim degrades to
  // "inventory only" rather than failing the capture.
  let shimWarning: string | undefined;
  try {
    await startPageShimCapture(tabId);
  } catch (error) {
    shimWarning = error instanceof Error
      ? `Page shim could not inject (${error.message}); capturing request inventory via webRequest only (no response bodies on this site).`
      : "Page shim could not inject; capturing request inventory via webRequest only (no response bodies on this site).";
  }

  return {
    action: "start",
    tabId,
    capturing: true,
    source: "web-request",
    warnings: shimWarning ? [...warnings, shimWarning] : warnings,
    message:
      `Network capture started on tab ${tabId} (webRequest + page shim). Reload or interact with the page to capture requests, then call summary. ` +
      "No Chrome debugging banner is shown; surface that capture is active in the UI."
  };
}

async function stopCapture(tabId: number): Promise<CaptureToolResult> {
  const wasCapturing = isCapturing(tabId);
  await stopCdpCapture(tabId);
  stopPageShimCapture(tabId);
  stopWebRequestCapture(tabId);
  const buffer = getBuffer(tabId);
  return {
    action: "stop",
    tabId,
    capturing: false,
    source: buffer?.source ?? "none",
    summary: buffer ? buildSummary(buffer, false) : undefined,
    warnings: wasCapturing ? [] : [`No active capture was running on tab ${tabId}.`],
    message: wasCapturing
      ? `Network capture stopped on tab ${tabId}. Buffer retained for summary/dump.`
      : `No active capture on tab ${tabId}.`
  };
}

async function summarize(tabId: number): Promise<CaptureToolResult> {
  const buffer = getBuffer(tabId);
  if (!buffer) {
    return {
      action: "summary",
      tabId,
      capturing: false,
      source: "none",
      warnings: [`No capture buffer for tab ${tabId}. Call start first.`],
      message: `No capture data for tab ${tabId}.`
    };
  }
  const capturing = isCapturing(tabId);
  const summary = buildSummary(buffer, capturing);
  const sensitiveNote = summary.sensitiveSummary.length
    ? ` Sensitive items present (${summary.sensitiveSummary.map((s) => `${s.kind}:${s.requestCount}`).join(", ")}); a raw dump exposes their values.`
    : "";
  return {
    action: "summary",
    tabId,
    capturing,
    source: buffer.source,
    summary,
    warnings: [],
    message:
      `${summary.totalRequests} request(s), ${summary.endpoints.length} distinct endpoint(s), ` +
      `${summary.graphqlOperations.length} GraphQL op(s), ${summary.totalWebSocketFrames} WS frame(s).${sensitiveNote}`
  };
}

async function dump(input: CaptureToolInput): Promise<CaptureToolResult> {
  const buffer = getBuffer(input.tabId);
  if (!buffer) {
    return {
      action: "dump",
      tabId: input.tabId,
      capturing: false,
      source: "none",
      warnings: [`No capture buffer for tab ${input.tabId}. Call start first.`],
      message: `No capture data for tab ${input.tabId}.`
    };
  }

  const urlIncludes = input.urlIncludes?.toLowerCase();
  const methods = input.methods?.map((method) => method.toUpperCase());
  const includeBodies = input.includeBodies ?? true;
  const maxRequests = clampMax(input.maxRequests, 50);

  let requests = buffer.requests.filter((request) => {
    if (urlIncludes && !request.url.toLowerCase().includes(urlIncludes)) {
      return false;
    }
    if (methods && methods.length && !methods.includes(request.method.toUpperCase())) {
      return false;
    }
    if (input.onlySensitive && request.sensitiveKinds.length === 0) {
      return false;
    }
    return true;
  });

  const matched = requests.length;
  requests = requests.slice(Math.max(0, requests.length - maxRequests));
  const projected = requests.map((request) => projectRequest(request, includeBodies));

  const warnings: string[] = [];
  if (matched > requests.length) {
    warnings.push(`Returned the latest ${requests.length} of ${matched} matching request(s).`);
  }
  const sensitiveCount = projected.filter((request) => request.sensitiveKinds.length).length;
  if (sensitiveCount && includeBodies) {
    warnings.push(`${sensitiveCount} returned request(s) contain un-redacted credentials (JWT/cookie/authorization/api-key).`);
  }

  return {
    action: "dump",
    tabId: input.tabId,
    capturing: isCapturing(input.tabId),
    source: buffer.source,
    requests: projected,
    warnings,
    message: `Dumped ${projected.length} request(s) from tab ${input.tabId}.`
  };
}

function projectRequest(request: CapturedRequest, includeBodies: boolean): CapturedRequest {
  if (includeBodies) {
    return request;
  }
  return {
    ...request,
    requestBody: undefined,
    responseBody: request.responseBody ? "[body omitted: includeBodies=false]" : undefined
  };
}

function clampMax(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return fallback;
  }
  return Math.min(500, Math.round(value));
}

/** Exposed for the executor to discard a buffer after a tab is done. */
export function discardCapture(tabId: number): void {
  clearBuffer(tabId);
}
