/**
 * Shared network-capture buffer for the browser inspection toolset (slice 1).
 *
 * Two sources feed this buffer with the same {@link CapturedRequest} shape:
 *   - webRequestCapture.ts (chrome.webRequest) — CSP-proof request inventory spine
 *   - pageShim.ts          (MAIN-world fetch/XHR/WebSocket monkey-patch) — body/WS enrichment
 *   - cdpCapture.ts        (chrome.debugger / CDP Network domain) — opt-in, off by default
 *
 * The buffer is per-tab, size-capped (a ring buffer), and tags — but never masks —
 * values that look like credentials so the summary can warn the user what a raw
 * dump will expose. Per the agreed data-to-model policy: compact summary by
 * default, raw bodies (un-redacted) only on explicit dump.
 */

export type CaptureSource = "cdp" | "page-shim" | "web-request";

export type SensitiveKind = "jwt" | "authorization" | "cookie" | "api-key" | "bearer";

export type CapturedHeader = {
  name: string;
  value: string;
  /** Populated when the header value matches a known credential pattern. */
  sensitive?: SensitiveKind;
};

export type CapturedRequest = {
  id: string;
  source: CaptureSource;
  startedAtMs: number;
  method: string;
  url: string;
  origin?: string;
  path?: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  requestHeaders: CapturedHeader[];
  responseHeaders: CapturedHeader[];
  requestBody?: string;
  responseBody?: string;
  /** True when the response body was not (yet) available from the source. */
  responseBodyPending?: boolean;
  /** GraphQL operation metadata when the request looks like a GraphQL call. */
  graphql?: {
    operationName?: string;
    operationType?: "query" | "mutation" | "subscription";
  };
  /** Distinct sensitive-credential kinds detected anywhere in this entry. */
  sensitiveKinds: SensitiveKind[];
  /** True when this entry was buffered before capture started, then flushed. */
  preStart?: boolean;
};

export type WebSocketFrame = {
  id: string;
  source: CaptureSource;
  atMs: number;
  url?: string;
  direction: "sent" | "received";
  opcode?: number;
  payloadLength: number;
  /** Truncated preview; full payload only retained up to the per-frame cap. */
  payloadPreview: string;
  payload?: string;
  /** True when this frame was buffered before capture started, then flushed. */
  preStart?: boolean;
};

export type CaptureBuffer = {
  tabId: number;
  source: CaptureSource;
  startedAtMs: number;
  requests: CapturedRequest[];
  webSocketFrames: WebSocketFrame[];
  /** Count of entries dropped because the ring buffer was full. */
  droppedRequests: number;
  droppedFrames: number;
};

const MAX_REQUESTS = 500;
const MAX_FRAMES = 500;
const MAX_BODY_CHARS = 200_000;
const MAX_FRAME_PREVIEW_CHARS = 2_000;

const buffersByTab = new Map<number, CaptureBuffer>();

export function createBuffer(tabId: number, source: CaptureSource): CaptureBuffer {
  const buffer: CaptureBuffer = {
    tabId,
    source,
    startedAtMs: Date.now(),
    requests: [],
    webSocketFrames: [],
    droppedRequests: 0,
    droppedFrames: 0
  };
  buffersByTab.set(tabId, buffer);
  return buffer;
}

export function getBuffer(tabId: number): CaptureBuffer | undefined {
  return buffersByTab.get(tabId);
}

export function clearBuffer(tabId: number): void {
  buffersByTab.delete(tabId);
}

export function hasBuffer(tabId: number): boolean {
  return buffersByTab.has(tabId);
}

export function addRequest(buffer: CaptureBuffer, request: CapturedRequest): void {
  tagRequest(request);
  if (buffer.requests.length >= MAX_REQUESTS) {
    buffer.requests.shift();
    buffer.droppedRequests += 1;
  }
  buffer.requests.push(request);
}

/**
 * Window (ms) within which a page-shim request is considered the same call as a
 * web-request entry, so the shim's response body can enrich it instead of being
 * recorded as a duplicate endpoint.
 */
const SHIM_MERGE_WINDOW_MS = 8_000;

/**
 * Add a page-shim request, MERGING it into an existing web-request entry for the
 * same call when one is present (so the two sources don't double-count the same
 * endpoint). webRequest is the authoritative inventory (it sees every request,
 * even under strict CSP) but cannot read response bodies; the shim can, so when
 * the shim observes a request webRequest already logged, we copy the shim's
 * bodies/headers onto that entry. Only when no match exists (shim-only call, or
 * webRequest hasn't fired yet) is the shim request added standalone.
 *
 * Matching is method + URL within a recent time window, newest first — the same
 * heuristic DevTools uses to reconcile sources. WebSocket frames are never
 * merged here (webRequest cannot see WS payloads); they go through addFrame.
 */
export function mergeShimRequest(buffer: CaptureBuffer, shimRequest: CapturedRequest): void {
  for (let index = buffer.requests.length - 1; index >= 0; index -= 1) {
    const existing = buffer.requests[index];
    if (existing.source !== "web-request") {
      continue;
    }
    if (existing.method !== shimRequest.method || existing.url !== shimRequest.url) {
      continue;
    }
    if (Math.abs(existing.startedAtMs - shimRequest.startedAtMs) > SHIM_MERGE_WINDOW_MS) {
      continue;
    }
    // Enrich the authoritative web-request entry with what only the shim has.
    if (existing.requestBody === undefined && shimRequest.requestBody !== undefined) {
      existing.requestBody = shimRequest.requestBody;
    }
    if ((existing.responseBody === undefined || existing.responseBodyPending) && shimRequest.responseBody !== undefined) {
      existing.responseBody = shimRequest.responseBody;
      existing.responseBodyPending = false;
    }
    if (!existing.graphql && shimRequest.graphql) {
      existing.graphql = shimRequest.graphql;
    }
    if (existing.status === undefined && shimRequest.status !== undefined) {
      existing.status = shimRequest.status;
      existing.statusText = shimRequest.statusText;
    }
    // Re-tag: the newly attached bodies/headers may contain credentials.
    tagRequest(existing);
    return;
  }
  // No web-request match — record the shim request on its own.
  addRequest(buffer, shimRequest);
}

/** Find an in-flight request by id so a later event can attach status/body. */
export function findRequest(buffer: CaptureBuffer, id: string): CapturedRequest | undefined {
  for (let index = buffer.requests.length - 1; index >= 0; index -= 1) {
    if (buffer.requests[index].id === id) {
      return buffer.requests[index];
    }
  }
  return undefined;
}

export function addFrame(buffer: CaptureBuffer, frame: WebSocketFrame): void {
  if (buffer.webSocketFrames.length >= MAX_FRAMES) {
    buffer.webSocketFrames.shift();
    buffer.droppedFrames += 1;
  }
  buffer.webSocketFrames.push(frame);
}

export function clampBody(body: string | undefined): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}...[truncated ${body.length - MAX_BODY_CHARS} chars]`
    : body;
}

export function framePreview(payload: string): string {
  return payload.length > MAX_FRAME_PREVIEW_CHARS
    ? `${payload.slice(0, MAX_FRAME_PREVIEW_CHARS)}...[truncated]`
    : payload;
}

// --- Sensitive-value tagging (tag, never mask) ---------------------------------

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const BEARER_PATTERN = /^bearer\s+\S+/i;
const API_KEY_HEADER = /^(x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;
const COOKIE_HEADER = /^(cookie|set-cookie)$/i;

function classifyHeader(name: string, value: string): SensitiveKind | undefined {
  const lower = name.toLowerCase();
  if (lower === "authorization") {
    return BEARER_PATTERN.test(value) ? "bearer" : "authorization";
  }
  if (COOKIE_HEADER.test(lower)) {
    return "cookie";
  }
  if (API_KEY_HEADER.test(lower)) {
    return "api-key";
  }
  if (JWT_PATTERN.test(value)) {
    return "jwt";
  }
  return undefined;
}

function tagRequest(request: CapturedRequest): void {
  const kinds = new Set<SensitiveKind>();

  for (const header of [...request.requestHeaders, ...request.responseHeaders]) {
    const kind = classifyHeader(header.name, header.value);
    if (kind) {
      header.sensitive = kind;
      kinds.add(kind);
    }
  }

  for (const body of [request.requestBody, request.responseBody]) {
    if (body && JWT_PATTERN.test(body)) {
      kinds.add("jwt");
    }
  }

  if (JWT_PATTERN.test(request.url)) {
    kinds.add("jwt");
  }

  request.sensitiveKinds = [...kinds];
}

// --- Summary building (compact, default model payload) -------------------------

/**
 * Coarse classification of an endpoint for summary grouping. "data" = the
 * XHR/fetch/GraphQL/WebSocket calls that carry application data (the interesting
 * part of "what APIs does this page call"); "asset" = static resources
 * (scripts, styles, images, fonts, the document itself) that are usually noise
 * for an API question. Derived from webRequest's resourceType; shim/CDP entries
 * (which lack a resourceType) are treated as data, since the shim only patches
 * fetch/XHR/WebSocket.
 */
export type EndpointKind = "data" | "asset";

export type EndpointSummary = {
  method: string;
  origin: string;
  path: string;
  count: number;
  statuses: number[];
  sensitiveKinds: SensitiveKind[];
  kind: EndpointKind;
};

export type CaptureSummary = {
  tabId: number;
  source: CaptureSource;
  capturing: boolean;
  totalRequests: number;
  /** Requests classified as application-data calls (XHR/fetch/WS/GraphQL). */
  dataRequestCount: number;
  /** Requests classified as static assets (scripts/styles/images/fonts/docs). */
  assetRequestCount: number;
  /** Application-data requests that actually have a captured response body. */
  dataRequestsWithBody: number;
  droppedRequests: number;
  totalWebSocketFrames: number;
  droppedFrames: number;
  endpoints: EndpointSummary[];
  graphqlOperations: Array<{ operationType?: string; operationName?: string; count: number }>;
  origins: Array<{ origin: string; count: number }>;
  sensitiveSummary: Array<{ kind: SensitiveKind; requestCount: number }>;
  webSocketUrls: Array<{ url: string; sent: number; received: number }>;
};

/**
 * webRequest resourceType values that are static assets, not application-data
 * calls. Everything else (xmlhttprequest, websocket, ping, other, or absent)
 * counts as "data". An absent resourceType (shim/CDP) is data by default since
 * the shim only intercepts fetch/XHR/WebSocket.
 */
const ASSET_RESOURCE_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "media",
  "csp_report"
]);

function classifyEndpoint(resourceType: string | undefined): EndpointKind {
  if (!resourceType) {
    return "data";
  }
  return ASSET_RESOURCE_TYPES.has(resourceType) ? "asset" : "data";
}

export function buildSummary(buffer: CaptureBuffer, capturing: boolean): CaptureSummary {
  const endpoints = new Map<string, EndpointSummary>();
  const origins = new Map<string, number>();
  const graphql = new Map<string, { operationType?: string; operationName?: string; count: number }>();
  const sensitive = new Map<SensitiveKind, number>();
  let dataRequestsWithBody = 0;

  for (const request of buffer.requests) {
    if (classifyEndpoint(request.resourceType) === "data" && request.responseBody !== undefined) {
      dataRequestsWithBody += 1;
    }
    const origin = request.origin ?? originOf(request.url);
    const path = request.path ?? pathOf(request.url);
    const key = `${request.method} ${origin}${path}`;
    const endpointKind = classifyEndpoint(request.resourceType);
    const existing = endpoints.get(key);
    if (existing) {
      existing.count += 1;
      if (request.status !== undefined && !existing.statuses.includes(request.status)) {
        existing.statuses.push(request.status);
      }
      for (const kind of request.sensitiveKinds) {
        if (!existing.sensitiveKinds.includes(kind)) {
          existing.sensitiveKinds.push(kind);
        }
      }
      // Data wins: if any request for this endpoint is an app-data call, the
      // endpoint is data even if other requests to it looked like assets.
      if (endpointKind === "data") {
        existing.kind = "data";
      }
    } else {
      endpoints.set(key, {
        method: request.method,
        origin,
        path,
        count: 1,
        statuses: request.status !== undefined ? [request.status] : [],
        sensitiveKinds: [...request.sensitiveKinds],
        kind: endpointKind
      });
    }

    origins.set(origin, (origins.get(origin) ?? 0) + 1);

    if (request.graphql) {
      const gqlKey = `${request.graphql.operationType ?? "?"}:${request.graphql.operationName ?? "?"}`;
      const g = graphql.get(gqlKey);
      if (g) {
        g.count += 1;
      } else {
        graphql.set(gqlKey, {
          operationType: request.graphql.operationType,
          operationName: request.graphql.operationName,
          count: 1
        });
      }
    }

    for (const kind of request.sensitiveKinds) {
      sensitive.set(kind, (sensitive.get(kind) ?? 0) + 1);
    }
  }

  const wsUrls = new Map<string, { sent: number; received: number }>();
  for (const frame of buffer.webSocketFrames) {
    const url = frame.url ?? "(unknown)";
    const entry = wsUrls.get(url) ?? { sent: 0, received: 0 };
    if (frame.direction === "sent") {
      entry.sent += 1;
    } else {
      entry.received += 1;
    }
    wsUrls.set(url, entry);
  }

  const endpointList = [...endpoints.values()].sort((a, b) => b.count - a.count);
  let dataRequestCount = 0;
  let assetRequestCount = 0;
  for (const endpoint of endpointList) {
    if (endpoint.kind === "data") {
      dataRequestCount += endpoint.count;
    } else {
      assetRequestCount += endpoint.count;
    }
  }

  return {
    tabId: buffer.tabId,
    source: buffer.source,
    capturing,
    totalRequests: buffer.requests.length,
    dataRequestCount,
    assetRequestCount,
    dataRequestsWithBody,
    droppedRequests: buffer.droppedRequests,
    totalWebSocketFrames: buffer.webSocketFrames.length,
    droppedFrames: buffer.droppedFrames,
    endpoints: endpointList,
    graphqlOperations: [...graphql.values()].sort((a, b) => b.count - a.count),
    origins: [...origins.entries()].sort((a, b) => b[1] - a[1]).map(([origin, count]) => ({ origin, count })),
    sensitiveSummary: [...sensitive.entries()].map(([kind, requestCount]) => ({ kind, requestCount })),
    webSocketUrls: [...wsUrls.entries()].map(([url, counts]) => ({ url, ...counts }))
  };
}

// --- GraphQL / URL helpers (shared by both sources) ----------------------------

export function detectGraphql(url: string, body: string | undefined): CapturedRequest["graphql"] | undefined {
  const looksLikeGraphqlUrl = /\/graphql\b/i.test(url);
  if (!body && !looksLikeGraphqlUrl) {
    return undefined;
  }
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as { query?: string; operationName?: string } | Array<{ query?: string }>;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const query = typeof first?.query === "string" ? first.query : undefined;
    if (!query && !looksLikeGraphqlUrl) {
      return undefined;
    }
    const operationName = !Array.isArray(parsed) && typeof parsed.operationName === "string"
      ? parsed.operationName
      : operationNameFromQuery(query);
    return {
      operationType: operationTypeFromQuery(query),
      operationName
    };
  } catch {
    return looksLikeGraphqlUrl ? {} : undefined;
  }
}

function operationTypeFromQuery(query: string | undefined): "query" | "mutation" | "subscription" | undefined {
  if (!query) {
    return undefined;
  }
  const match = /\b(query|mutation|subscription)\b/i.exec(query.trimStart());
  return match ? (match[1].toLowerCase() as "query" | "mutation" | "subscription") : "query";
}

function operationNameFromQuery(query: string | undefined): string | undefined {
  if (!query) {
    return undefined;
  }
  const match = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match?.[1];
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unknown)";
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
