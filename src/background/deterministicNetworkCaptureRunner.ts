/**
 * Deterministic network-capture runner.
 *
 * Mirrors the deterministic research/workspace runners: it runs the capture
 * tools deterministically (start -> reload -> settle -> summarize), keeps the
 * raw buffer in memory, and produces a COMPACT, size-capped bundle. Only the
 * compact bundle is ever formatted for the LLM synthesis step — the raw
 * request/response bodies (the `dump`) never enter the model context. This is
 * the synthesis boundary that keeps tokens bounded while preserving the
 * deterministic + LLM hybrid architecture.
 *
 * The runner intentionally does NOT call the `dump` action. Raw entries stay in
 * the capture buffer and remain available to the user via the explicit
 * browser_capture_network dump tool, which is governed by the agreed
 * data-to-model policy (compact by default, raw only on explicit request).
 */

import { delay } from "../shared/asyncUtils";
import { makeId } from "../shared/id";
import type { RunProgressEvent } from "../shared/protocol";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import { shouldUsePageAppInspectionIntent } from "./pageAppInspectionIntent";
import { executeBrowserTool } from "../tools/browserToolExecutor";
import {
  ensureShimContentScripts,
  startPageShimCapture,
  waitForShimContentScriptsReady
} from "../tools/networkCapture/pageShimCapture";
import {
  addFrame,
  addRequest,
  buildSummary,
  clearBuffer,
  createBuffer,
  getBuffer,
  type CaptureSummary,
  type CapturedRequest,
  type WebSocketFrame
} from "../tools/networkCapture/captureBuffer";
import {
  captureViaCompanion,
  checkCompanionHealth,
  type CompanionCookie
} from "../companion/companionClient";
import type { RunControl } from "./runControl";

const SETTLE_POLL_MS = 400;
const SETTLE_QUIET_MS = 1_500;
const SETTLE_MAX_MS = 12_000;

export type DeterministicNetworkCaptureBundle = {
  id: string;
  tabId: number;
  startedAt: string;
  completedAt: string;
  status: "completed" | "partial" | "failed";
  capturing: boolean;
  reloaded: boolean;
  summary?: CaptureSummary;
  /**
   * True only on a genuine failure to capture (no tab, or capture could not
   * start at all). A blocked result cannot be made sufficient by re-running, so
   * the pipeline fast-fails with an honest explanation rather than replanning.
   * A normal page-shim capture — including an empty one — is NOT blocked.
   */
  captureBlocked: boolean;
  /** Human-readable reason capture was blocked (empty when not blocked). */
  blockedReason: string;
  /**
   * True when application-data calls were observed but NONE yielded a response
   * body — i.e. webRequest got the inventory but the in-page shim was blocked
   * (typically strict CSP), so bodies are unobtainable in-browser. A companion-
   * owned headless browser driving CDP WOULD capture them, so this is the signal
   * that raises the "full network capture" capability gap.
   */
  bodiesUnobtainable: boolean;
  warnings: string[];
  errors: string[];
};

/**
 * Derive the terminal "response bodies unobtainable in-browser" condition from a
 * summary: data calls exist, but none has a body, and we are not on the CDP
 * source (CDP would have bodies). Single source of truth for both the LLM-facing
 * terminal-limitation note and the capability-gap signal.
 */
export function bodiesUnobtainableFromSummary(summary: CaptureSummary | undefined): boolean {
  if (!summary) {
    return false;
  }
  return summary.source !== "cdp" && summary.dataRequestCount > 0 && summary.dataRequestsWithBody === 0;
}

export type DeterministicNetworkCapturePreflight = {
  bundle: DeterministicNetworkCaptureBundle;
  activity: ExecutionLogEntry[];
};

/**
 * Intent detection — does this prompt want a live network/API trace of the
 * current page? Kept conservative so it only fires on explicit capture asks.
 */
export function shouldRunDeterministicNetworkCapture(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase();
  if (!text) {
    return false;
  }

  // Live network capture is specifically about intercepting traffic / response
  // bodies. Note "inspect" is deliberately NOT a capture verb: prompts like
  // "inspect this page DOM tree and requests" are static page-app inspection,
  // handled by the existing browser_tool_loop path, not the debugger capture.
  const mentionsNetwork = /\b(network|xhr|fetch|requests?|api calls?|endpoints?|graphql|websocket|ws frames?|response bod(?:y|ies)|request bod(?:y|ies)|traffic|har)\b/.test(text);
  const mentionsCapture = /\b(capture|intercept|trace|monitor|record|sniff|reverse[ -]?engineer)\b/.test(text);
  const mentionsApiDesign = /\b(api design|data model|auth pattern|how (?:does|do) .* (?:talk to|call|communicate)|what (?:endpoints?|apis?))\b/.test(text);

  const wantsCapture = (mentionsNetwork && mentionsCapture) || mentionsApiDesign;
  if (!wantsCapture) {
    return false;
  }

  // Defer to static page-app inspection when the prompt is really a broad
  // DOM/structure/storage inspection that merely mentions network in passing.
  const mentionsStructure = /\b(dom|element tree|accessibility tree|structure|storage|localstorage|sessionstorage|scripts?|styles?|forms?|components?|routes?)\b/.test(text);
  if (mentionsStructure && shouldUsePageAppInspectionIntent(userMessage) && !mentionsCapture) {
    return false;
  }

  return true;
}

export async function runDeterministicNetworkCapturePreflight(args: {
  userMessage: string;
  tabId?: number;
  onProgress?: (event: RunProgressEvent) => void;
  control?: RunControl;
}): Promise<DeterministicNetworkCapturePreflight> {
  const activity: ExecutionLogEntry[] = [];
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];

  const emit = (event: Omit<RunProgressEvent, "id" | "timestamp">) => {
    args.onProgress?.({ id: makeId("progress"), timestamp: new Date().toISOString(), ...event });
  };
  const log = (entry: Omit<ExecutionLogEntry, "id" | "timestamp">) => {
    activity.push({ id: makeId("log"), timestamp: new Date().toISOString(), ...entry });
  };

  // 1. Resolve target tab.
  let tabId = args.tabId;
  if (tabId === undefined) {
    const tabResult = await executeBrowserTool({ id: makeId("cap"), name: "browser_read_active_tab", input: {} });
    const output = tabResult.output as { tab?: { id?: number } } | undefined;
    tabId = output?.tab?.id;
  }
  if (tabId === undefined) {
    return failBundle("No active tab to capture network traffic from.");
  }

  // 1b. COMPANION (full mode): if the local engine is running, capture via it —
  //     it drives its own headless Chromium over CDP and gets the FULL response
  //     bodies + WS payloads the in-browser path can't. Best-effort: any failure
  //     falls through to the in-browser shim+webRequest path below.
  const companionBundle = await tryCompanionCapture(tabId, startedAt, emit, log, args.control);
  if (companionBundle) {
    return { bundle: companionBundle, activity };
  }

  // 2. Start capture. Two no-banner sources start together: the chrome.webRequest
  //    spine (CSP-proof request inventory) and the MAIN-world shim (response
  //    bodies + WS payloads where the page CSP allows). chrome.debugger/CDP is
  //    off by default, so no "debugging this browser" banner is ever shown.
  emit({ level: "info", label: "Network capture", detail: `Starting capture on tab ${tabId}.`, status: "running" });
  const start = await executeBrowserTool({
    id: makeId("cap"),
    name: "browser_capture_network",
    input: { action: "start", tabId }
  }, { allowPageActions: true });
  log(start.activity);
  const startOutput = start.output as { capturing?: boolean; source?: string } | undefined;
  if (!startOutput?.capturing) {
    warnings.push(...start.warnings);
    return failBundle(start.error ?? start.summary ?? "Network capture could not start.", tabId);
  }

  // 3. Ensure the document_start shim is registered AND APPLIED before the
  //    reload. The on-demand shim injected by start() lives in the pre-reload
  //    document and is destroyed by the reload, so the only thing that can see
  //    the reload's load-time traffic is the document_start registered content
  //    script. Awaiting registerContentScripts is not enough on a cold service
  //    worker — poll getRegisteredContentScripts until the ids are confirmed
  //    present, so the new document provably carries the shim.
  await ensureShimContentScripts();
  const shimReady = await waitForShimContentScriptsReady();
  if (!shimReady) {
    warnings.push("Document-start shim was not confirmed registered before reload; some load-time requests may be missed.");
  }

  // 4. Reload the tab so load-time traffic is captured.
  let reloaded = false;
  try {
    await args.control?.checkpoint();
    const reload = await executeBrowserTool({
      id: makeId("cap"),
      name: "browser_navigate_active_tab",
      input: { action: "reload", tabId }
    }, { allowPageActions: true });
    log(reload.activity);
    reloaded = reload.status !== "failed";
    if (!reloaded) {
      warnings.push("Could not reload the tab; capturing only post-attach traffic.");
    }
  } catch {
    warnings.push("Reload step skipped; capturing only post-attach traffic.");
  }

  // 5. Re-run the MAIN-world shim install against the POST-reload document. The
  //    reload produced a fresh document whose document_start shim buffered its
  //    load-time entries into a pre-start ring but never flushed (start()'s
  //    flush fired against the now-gone pre-reload document). Re-injecting here
  //    is the flush signal: the sentinel guard makes the patch apply once, and
  //    flush() drains the ring buffer into the relay exactly once.
  if (reloaded) {
    try {
      await args.control?.checkpoint();
      await startPageShimCapture(tabId);
    } catch {
      warnings.push("Could not re-arm capture after reload; load-time requests may be missed.");
    }
  }

  // 6. Settle: wait until the buffer stops growing (quiet window) or timeout.
  emit({ level: "info", label: "Network capture", detail: "Waiting for network to settle.", status: "running" });
  await settleUntilQuiet(tabId, args.control);

  // 7. Build the compact summary deterministically.
  const buffer = getBuffer(tabId);
  const summary = buffer ? buildSummary(buffer, true) : undefined;

  // 8. Stop capture but keep the buffer for an explicit user dump later.
  const stop = await executeBrowserTool({
    id: makeId("cap"),
    name: "browser_capture_network",
    input: { action: "stop", tabId }
  });
  log(stop.activity);

  const completedAt = new Date().toISOString();
  const total = summary?.totalRequests ?? 0;
  emit({
    level: "info",
    label: "Network capture",
    detail: `Captured ${total} request(s), ${summary?.endpoints.length ?? 0} endpoint(s).`,
    status: "completed"
  });

  // The MAIN-world page-shim is the intended primary source: registered at
  // document_start, it buffers requests from page load onward and flushes them
  // on start, so a shim capture is a normal success — NOT a blocked result.
  // Blocking is owned solely by the genuine-failure path (failBundle), which
  // fires when there is no tab or capture could not start at all.
  const captureBlocked = false;
  const blockedReason = "";

  const bundle: DeterministicNetworkCaptureBundle = {
    id: makeId("network_capture"),
    tabId,
    startedAt,
    completedAt,
    status: total > 0 ? "completed" : "partial",
    capturing: false,
    reloaded,
    summary,
    captureBlocked,
    blockedReason,
    bodiesUnobtainable: bodiesUnobtainableFromSummary(summary),
    warnings,
    errors
  };
  return { bundle, activity };

  function failBundle(message: string, failedTabId?: number): DeterministicNetworkCapturePreflight {
    errors.push(message);
    emit({ level: "error", label: "Network capture", detail: message, status: "failed" });
    return {
      bundle: {
        id: makeId("network_capture"),
        tabId: failedTabId ?? -1,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        capturing: false,
        reloaded: false,
        captureBlocked: true,
        blockedReason: `Network capture could not run: ${message}`,
        bodiesUnobtainable: false,
        warnings,
        errors
      },
      activity
    };
  }
}

/**
 * Try to capture via the local engine (full CDP). Returns a completed "cdp"
 * bundle on success, or undefined to fall through to the in-browser path when
 * the engine is absent or anything fails. The engine loads the tab's URL in its
 * own headless browser with the tab origin's cookies injected, so it sees the
 * user's authenticated session and can read response bodies the browser can't.
 */
async function tryCompanionCapture(
  tabId: number,
  startedAt: string,
  emit: (event: Omit<RunProgressEvent, "id" | "timestamp">) => void,
  log: (entry: Omit<ExecutionLogEntry, "id" | "timestamp">) => void,
  control?: RunControl
): Promise<DeterministicNetworkCaptureBundle | undefined> {
  try {
    const health = await checkCompanionHealth();
    if (!health.connected || !health.token || !health.capabilities?.includes("full_network_capture")) {
      return undefined;
    }

    // Resolve the tab's URL + origin (the engine loads this; cookies scope to it).
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const url = tab?.url;
    if (!url || !/^https?:/i.test(url)) {
      return undefined; // engine can't meaningfully load chrome:// etc.
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return undefined;
    }

    await control?.checkpoint();
    emit({ level: "info", label: "Network capture", detail: "Capturing via the local engine (full response bodies).", status: "running" });

    // Export this origin's cookies from the user's own Chrome (only this origin).
    const rawCookies = await chrome.cookies.getAll({ url }).catch(() => [] as chrome.cookies.Cookie[]);
    const cookies: CompanionCookie[] = rawCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate
    }));

    const result = await captureViaCompanion({ url, cookies, token: health.token });

    // Ingest the engine's "cdp" entries into a fresh cdp buffer + summarize.
    clearBuffer(tabId);
    const buffer = createBuffer(tabId, "cdp");
    for (const r of result.requests as CapturedRequest[]) {
      addRequest(buffer, { ...r, source: "cdp" });
    }
    for (const f of result.webSocketFrames as WebSocketFrame[]) {
      addFrame(buffer, { ...f, source: "cdp" });
    }
    const summary = buildSummary(buffer, false);
    log({
      level: "info",
      label: "Network capture",
      details: `Captured ${summary.totalRequests} request(s) via the local engine (${summary.dataRequestsWithBody} with response bodies).`,
      toolName: "background_engine",
      actionLabel: "Engine capture",
      status: "completed"
    });
    emit({
      level: "info",
      label: "Network capture",
      detail: `Captured ${summary.totalRequests} request(s) via the local engine.`,
      status: "completed"
    });

    return {
      id: makeId("network_capture"),
      tabId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: summary.totalRequests > 0 ? "completed" : "partial",
      capturing: false,
      reloaded: true,
      summary,
      captureBlocked: false,
      blockedReason: "",
      // The engine got bodies (or there were none) — never raise the capability
      // gap when capture went through the engine.
      bodiesUnobtainable: false,
      warnings: [],
      errors: []
    };
  } catch {
    // Any failure → fall through to the in-browser shim+webRequest path.
    return undefined;
  }
}

/** Poll the buffer size; resolve once it has been quiet for SETTLE_QUIET_MS. */
async function settleUntilQuiet(tabId: number, control?: RunControl): Promise<void> {
  const deadline = Date.now() + SETTLE_MAX_MS;
  let lastCount = bufferRequestCount(tabId);
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await control?.checkpoint();
    await delay(SETTLE_POLL_MS);
    const count = bufferRequestCount(tabId);
    if (count !== lastCount) {
      lastCount = count;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= SETTLE_QUIET_MS) {
      return;
    }
  }
}

function bufferRequestCount(tabId: number): number {
  return getBuffer(tabId)?.requests.length ?? 0;
}

/**
 * Format the compact bundle for the LLM synthesis step. Caps every list so the
 * synthesis prompt stays bounded regardless of capture volume. Never includes
 * raw request/response bodies.
 */
export function formatDeterministicNetworkCaptureForLlm(bundle: DeterministicNetworkCaptureBundle): string {
  if (!bundle.summary || bundle.status === "failed") {
    const reason = bundle.errors[0] ?? "No network traffic was captured.";
    return `Network capture unavailable: ${reason}`;
  }

  const summary = bundle.summary;
  const lines: string[] = [];
  const sourceLabel =
    summary.source === "cdp"
      ? "Chrome DevTools Protocol (full capture)"
      : summary.source === "web-request"
        ? "webRequest + page-shim (CSP-proof inventory, body/WS enrichment)"
        : "page-shim";
  lines.push(`Network capture for tab ${bundle.tabId} (reloaded: ${bundle.reloaded}, source: ${sourceLabel}).`);
  lines.push(
    `Totals: ${summary.totalRequests} request(s)${summary.droppedRequests ? ` (+${summary.droppedRequests} dropped)` : ""} ` +
    `= ${summary.dataRequestCount} application-data/API call(s) + ${summary.assetRequestCount} static asset(s); ` +
    `${summary.totalWebSocketFrames} WebSocket frame(s).`
  );

  // Make a zero result self-explaining. The reload + document_start shim means
  // load-time traffic IS captured, so an empty result means no page-context
  // requests were observed in the captured window — note neutrally that some
  // resources may be served from HTTP cache or a service worker and so are not
  // visible to page-context capture.
  if (summary.totalRequests === 0) {
    lines.push(
      summary.source === "cdp"
        ? "No requests were captured. The page made no XHR/fetch/WebSocket calls during the captured window (it may load entirely from the initial document, or be genuinely idle)."
        : summary.source === "web-request"
          ? "No requests were captured. webRequest observes traffic at the network layer regardless of the page's CSP, so an empty result means the page genuinely made no network requests in the captured window (e.g. fully cached, served by a service worker, or idle)."
          : "No requests were observed during the captured window. The page may make no XHR/fetch/WebSocket calls, or some resources may be served from HTTP cache or a service worker and so are not visible to page-context capture."
    );
  } else if (summary.source === "web-request") {
    lines.push("Note: request inventory (URLs/methods/status/headers) is from webRequest and is complete. Response bodies and WebSocket frame payloads are present only where the in-page shim could run; on strict-CSP sites those may be absent.");
  } else if (summary.source === "page-shim") {
    lines.push("Note: captured via the page-shim path. Opaque cross-origin responses and resources served from HTTP cache or a service worker may be absent.");
  }

  if (summary.origins.length) {
    lines.push("", "Origins by request count:");
    for (const origin of summary.origins.slice(0, 15)) {
      lines.push(`- ${origin.origin}: ${origin.count}`);
    }
  }

  const dataEndpoints = summary.endpoints.filter((endpoint) => endpoint.kind === "data");
  const assetEndpoints = summary.endpoints.filter((endpoint) => endpoint.kind === "asset");

  const renderEndpoint = (endpoint: typeof summary.endpoints[number]): string => {
    const statuses = endpoint.statuses.length ? ` [${endpoint.statuses.join(",")}]` : "";
    const sensitive = endpoint.sensitiveKinds.length ? ` {sensitive: ${endpoint.sensitiveKinds.join(",")}}` : "";
    return `- ${endpoint.method} ${endpoint.origin}${endpoint.path} ×${endpoint.count}${statuses}${sensitive}`;
  };

  // Application-data / API endpoints are the interesting part of "what APIs does
  // this page call" — list them prominently and in full (up to a generous cap),
  // ahead of and separate from the static-asset noise.
  if (dataEndpoints.length) {
    lines.push("", `Application-data / API endpoints (${Math.min(dataEndpoints.length, 60)} of ${dataEndpoints.length}):`);
    for (const endpoint of dataEndpoints.slice(0, 60)) {
      lines.push(renderEndpoint(endpoint));
    }
  } else if (summary.totalRequests > 0) {
    lines.push("", "No application-data / API calls (XHR/fetch/GraphQL/WebSocket) were observed — all captured requests were static assets (document, scripts, styles, images, fonts).");
  }

  // Static assets are usually noise for an API question: summarize them by
  // origin rather than listing every file, with a short sample.
  if (assetEndpoints.length) {
    const byOrigin = new Map<string, number>();
    for (const endpoint of assetEndpoints) {
      byOrigin.set(endpoint.origin, (byOrigin.get(endpoint.origin) ?? 0) + endpoint.count);
    }
    const originRollup = [...byOrigin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push("", `Static assets: ${summary.assetRequestCount} request(s) across ${assetEndpoints.length} resource(s), by origin:`);
    for (const [origin, count] of originRollup) {
      lines.push(`- ${origin}: ${count}`);
    }
  }

  if (summary.graphqlOperations.length) {
    lines.push("", "GraphQL operations:");
    for (const op of summary.graphqlOperations.slice(0, 30)) {
      lines.push(`- ${op.operationType ?? "?"} ${op.operationName ?? "(anonymous)"} ×${op.count}`);
    }
  }

  if (summary.webSocketUrls.length) {
    lines.push("", "WebSocket connections:");
    for (const ws of summary.webSocketUrls.slice(0, 10)) {
      lines.push(`- ${ws.url}: sent ${ws.sent}, received ${ws.received}`);
    }
  }

  if (summary.sensitiveSummary.length) {
    lines.push("", "Sensitive credential signals detected (values NOT included here):");
    for (const item of summary.sensitiveSummary) {
      lines.push(`- ${item.kind}: in ${item.requestCount} request(s)`);
    }
    lines.push("To see actual credential values, the user can run an explicit network dump.");
  }

  // Terminal-limitation marker for the sufficiency gate. webRequest cannot read
  // response bodies (MV3) and the MAIN-world shim — the only source that can —
  // is blocked by a strict page CSP. When the capture used the webRequest source
  // and a body-blocking warning is present, response bodies are PERMANENTLY
  // unobtainable for this page: re-running capture will return the same result.
  // The gate prompt treats a "TERMINAL LIMITATION" line as a reason to
  // synthesize, not replan, so the pipeline stops chasing data it cannot get.
  // Grounded in fact, not warning text: data calls were observed but NONE
  // yielded a response body. webRequest cannot read bodies (MV3) and the shim —
  // the only source that can — produced none, so for this page bodies are
  // permanently unobtainable. (A POST-only/204 endpoint legitimately has no
  // body, but if EVERY data call lacks one, the shim was effectively blocked.)
  if (bodiesUnobtainableFromSummary(summary)) {
    lines.push(
      "",
      "TERMINAL LIMITATION: response bodies for this page's API calls could not be captured. chrome.webRequest cannot read response bodies (a Manifest V3 restriction) and the in-page shim — the only source that can — captured none (typically blocked by the page's Content-Security-Policy). This is NOT recoverable by re-running capture or by any other tool: the endpoint inventory above (URLs, methods, status codes, headers, sizes) is the complete obtainable result. Synthesize the answer from it; do not replan to look for response bodies."
    );
  }

  if (bundle.warnings.length) {
    lines.push("", `Warnings: ${bundle.warnings.join(" | ")}`);
  }

  return lines.join("\n");
}
