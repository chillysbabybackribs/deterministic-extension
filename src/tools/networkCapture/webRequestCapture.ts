/**
 * CSP-proof network-capture source: chrome.webRequest.
 *
 * Unlike the MAIN-world page shim, webRequest observes traffic at the browser's
 * network layer, so it is NOT subject to the page's Content-Security-Policy and
 * works on every site — including strict-CSP pages where the injected shim is
 * blocked. It is the authoritative request *inventory*: method, URL, status,
 * request/response headers, timing, redirects, and request bodies.
 *
 * What it CANNOT see (by MV3 design): response bodies and WebSocket frame
 * payloads. Those come from the page shim, which enriches the same buffer entry
 * (see captureBuffer.mergeShimRequest). Together the two sources approximate
 * full CDP fidelity with no chrome.debugger banner.
 *
 * Listeners are registered once (process-wide) and self-filter to tabs with an
 * active capture, so an idle browser pays nothing. Per-request state is keyed by
 * webRequest's stable requestId across the event lifecycle.
 */

import {
  addRequest,
  findRequest,
  getBuffer,
  originOf,
  pathOf,
  type CaptureBuffer,
  type CapturedHeader
} from "./captureBuffer";

/** Tabs with an active webRequest capture. */
const activeTabs = new Set<number>();
/** Map requestId -> the entry id we recorded it under, for cross-event updates. */
const requestIdToEntryId = new Map<string, string>();
let listenersRegistered = false;

/** URL filter: all http(s) traffic. Tab gating happens in the handlers. */
const REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"]
};

export function isWebRequestCapturing(tabId: number): boolean {
  return activeTabs.has(tabId);
}

/**
 * Begin webRequest capture for a tab. Registers the process-wide listeners on
 * first use (idempotent) and marks the tab active. Safe to call repeatedly.
 */
export function startWebRequestCapture(tabId: number): void {
  registerListeners();
  if (!getBuffer(tabId)) {
    // Caller (startCapture) normally creates the buffer; create defensively so a
    // standalone webRequest start still has somewhere to land.
    return;
  }
  activeTabs.add(tabId);
}

export function stopWebRequestCapture(tabId: number): void {
  activeTabs.delete(tabId);
}

/**
 * Register the webRequest event listeners exactly once. Handlers no-op for tabs
 * that are not actively capturing, so leaving the listeners attached is cheap.
 * extraInfoSpec asks for the bits MV3 still allows: request bodies and headers.
 */
function registerListeners(): void {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  // onBeforeRequest: first event — create the entry, capture the request body.
  // (This event's overload is typed as blocking-capable, so the callback must
  // return BlockingResponse | undefined; we never block, so we return undefined.)
  chrome.webRequest.onBeforeRequest.addListener(
    (details): chrome.webRequest.BlockingResponse | undefined => {
      const buffer = bufferForActiveTab(details.tabId);
      if (!buffer) {
        return undefined;
      }
      const entryId = `wr-${details.requestId}`;
      requestIdToEntryId.set(details.requestId, entryId);
      addRequest(buffer, {
        id: entryId,
        source: "web-request",
        startedAtMs: details.timeStamp,
        method: details.method,
        url: details.url,
        origin: originOf(details.url),
        path: pathOf(details.url),
        resourceType: details.type,
        requestHeaders: [],
        responseHeaders: [],
        requestBody: extractRequestBody(details.requestBody),
        responseBodyPending: true,
        sensitiveKinds: []
      });
      return undefined;
    },
    REQUEST_FILTER,
    ["requestBody"]
  );

  // onSendHeaders: final request headers (after browser-added headers).
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const entry = entryFor(details.tabId, details.requestId);
      if (entry) {
        entry.requestHeaders = toHeaders(details.requestHeaders);
      }
    },
    REQUEST_FILTER,
    ["requestHeaders"]
  );

  // onHeadersReceived: response status + headers. (Blocking-capable overload —
  // return undefined; we observe only.)
  chrome.webRequest.onHeadersReceived.addListener(
    (details): chrome.webRequest.BlockingResponse | undefined => {
      const entry = entryFor(details.tabId, details.requestId);
      if (entry) {
        entry.status = details.statusCode;
        entry.responseHeaders = toHeaders(details.responseHeaders);
      }
      return undefined;
    },
    REQUEST_FILTER,
    ["responseHeaders"]
  );

  // onCompleted: finalize status + timing. Response body stays pending — only
  // the page shim can fill it, via captureBuffer.mergeShimRequest.
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const entry = entryFor(details.tabId, details.requestId);
      if (entry) {
        entry.status = details.statusCode;
        if (entry.responseHeaders.length === 0) {
          entry.responseHeaders = toHeaders(details.responseHeaders);
        }
        entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAtMs));
      }
      requestIdToEntryId.delete(details.requestId);
    },
    REQUEST_FILTER,
    ["responseHeaders"]
  );

  // onErrorOccurred: blocked/aborted/failed — record the failure, drop pending.
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const entry = entryFor(details.tabId, details.requestId);
      if (entry) {
        entry.statusText = details.error;
        entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry.startedAtMs));
        entry.responseBodyPending = false;
      }
      requestIdToEntryId.delete(details.requestId);
    },
    REQUEST_FILTER
  );
}

function bufferForActiveTab(tabId: number): CaptureBuffer | undefined {
  if (tabId < 0 || !activeTabs.has(tabId)) {
    return undefined;
  }
  return getBuffer(tabId);
}

function entryFor(tabId: number, requestId: string) {
  const buffer = bufferForActiveTab(tabId);
  if (!buffer) {
    return undefined;
  }
  const entryId = requestIdToEntryId.get(requestId);
  return entryId ? findRequest(buffer, entryId) : undefined;
}

function toHeaders(headers: chrome.webRequest.HttpHeader[] | undefined): CapturedHeader[] {
  if (!headers) {
    return [];
  }
  return headers.map((header) => ({
    name: header.name,
    value: header.value ?? (header.binaryValue ? "[binary]" : "")
  }));
}

/**
 * Reduce webRequest's structured requestBody into a string. Handles the two
 * shapes Chrome provides: raw bytes (e.g. JSON/text fetch bodies) and parsed
 * formData (urlencoded/multipart). Returns undefined for empty/binary-only.
 */
function extractRequestBody(
  body: chrome.webRequest.OnBeforeRequestDetails["requestBody"] | undefined
): string | undefined {
  if (!body) {
    return undefined;
  }
  if (body.formData) {
    try {
      return JSON.stringify(body.formData);
    } catch {
      return undefined;
    }
  }
  if (body.raw && body.raw.length) {
    const decoder = typeof TextDecoder === "function" ? new TextDecoder() : undefined;
    const parts: string[] = [];
    for (const element of body.raw) {
      if (element.bytes && decoder) {
        try {
          parts.push(decoder.decode(element.bytes));
        } catch {
          // non-text bytes — skip
        }
      }
    }
    const joined = parts.join("");
    return joined.length ? joined : undefined;
  }
  return undefined;
}
