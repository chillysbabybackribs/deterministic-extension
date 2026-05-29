/**
 * Single source of truth for the injected MAIN-world network shim and its
 * ISOLATED-world bridge.
 *
 * These functions are used two ways and MUST stay self-contained (no module
 * imports inside the function bodies, only their args + page globals):
 *   1. On-demand: serialized by chrome.scripting.executeScript at capture time
 *      (see pageShimCapture.startPageShimCapture). The constants are passed as
 *      args because a serialized func cannot close over module scope.
 *   2. document_start: bundled into standalone content-script entry files
 *      (src/content/netShimMain.ts, src/content/netShimBridge.ts) that import
 *      and call them with the same constants, so the shim is present before the
 *      page's own scripts run (see pageShimCapture.ensureShimContentScripts).
 *
 * Both install paths are idempotent via window-level sentinels, so a
 * document_start registration and an on-demand injection cannot double-patch.
 */

export const SHIM_MESSAGE_TYPE = "ohmygod-netshim-entry";
export const RELAY_MESSAGE_TYPE = "ohmygod-netshim-relay";

/**
 * Bounded pre-start ring-buffer caps (MAIN world, per document/frame).
 *
 * From document_start the shim records every entry into a ring buffer
 * regardless of capture state, so a page load that precedes start() is not
 * lost. The buffer is bounded on three axes so an idle tab that never starts
 * capture holds only a trivial, self-evicting amount; oldest entries are
 * evicted first when any cap is exceeded. These are deliberately conservative.
 */
export const MAX_PRESTART_ENTRIES = 200;
export const MAX_PRESTART_BYTES = 512_000;
export const MAX_PRESTART_AGE_MS = 60_000;

/** ISOLATED world: forward MAIN-world postMessage events to the service worker. */
export function installShimBridge(shimType: string, relayType: string): void {
  const w = window as unknown as { __ohmygodShimBridge?: boolean };
  if (w.__ohmygodShimBridge) {
    return;
  }
  w.__ohmygodShimBridge = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as { type?: string; entry?: unknown } | null;
    if (!data || data.type !== shimType) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: relayType, entry: data.entry });
    } catch {
      // Service worker may be asleep; entries are best-effort.
    }
  });
}

/**
 * MAIN world: patch fetch/XHR/WebSocket and post captured metadata.
 *
 * Install paths:
 *   - document_start content script calls with flushOnInstall=false (the
 *     default): the shim records into the bounded pre-start ring buffer and
 *     relays nothing until start() flushes it.
 *   - The on-demand start() injection re-runs this. If the shim already exists
 *     (document_start case) it flushes the buffer and goes live. If this is the
 *     FIRST install (no document_start ran for this tab), flushOnInstall=true
 *     makes it go live immediately, flushing an empty buffer.
 */
export function installNetworkShim(shimType: string, flushOnInstall = false): void {
  // Caps are inlined as literals because this function is serialized into the
  // page (executeScript) and also bundled into a content script; it cannot read
  // the module-level MAX_PRESTART_* constants at runtime. Keep these in sync with
  // the exported constants above.
  const MAX_PRESTART_ENTRIES = 200;
  const MAX_PRESTART_BYTES = 512_000;
  const MAX_PRESTART_AGE_MS = 60_000;

  type BufferedEntry = { entry: Record<string, unknown>; bytes: number; atMs: number };
  type ShimState = {
    installed: true;
    /** undefined while live (already flushed); an array while buffering pre-start. */
    preStart?: BufferedEntry[];
    preStartBytes: number;
    flush: () => void;
  };
  const w = window as unknown as { __ohmygodNetShim?: ShimState | boolean };

  // Already installed: the re-install that start() triggers (executeScript on top
  // of the document_start registration) is repurposed as the flush signal. The
  // sentinel guards against a second patch AND a second buffer instance.
  if (w.__ohmygodNetShim) {
    const existing = w.__ohmygodNetShim;
    if (typeof existing === "object" && typeof existing.flush === "function") {
      existing.flush();
    }
    return;
  }

  const state: ShimState = {
    installed: true,
    preStart: [],
    preStartBytes: 0,
    flush: () => undefined
  };
  w.__ohmygodNetShim = state;

  const MAX_BODY = 50_000;
  const clip = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : value.length > MAX_BODY ? value.slice(0, MAX_BODY) : value;

  const relay = (entry: Record<string, unknown>): void => {
    try {
      window.postMessage({ type: shimType, entry }, "*");
    } catch {
      // Non-cloneable payloads are dropped silently.
    }
  };

  const estimateBytes = (entry: Record<string, unknown>): number => {
    try {
      return JSON.stringify(entry).length;
    } catch {
      return 0;
    }
  };

  // Drop entries that are too old, or evict oldest-first until count/byte caps hold.
  const evictPreStart = (): void => {
    const buffer = state.preStart;
    if (!buffer) {
      return;
    }
    const cutoff = Date.now() - MAX_PRESTART_AGE_MS;
    while (buffer.length && buffer[0].atMs < cutoff) {
      state.preStartBytes -= buffer.shift()!.bytes;
    }
    while (buffer.length > MAX_PRESTART_ENTRIES || (buffer.length && state.preStartBytes > MAX_PRESTART_BYTES)) {
      state.preStartBytes -= buffer.shift()!.bytes;
    }
  };

  // Flush the pre-start ring buffer once, in original order, marking each entry
  // preStart:true, then switch to live pass-through. Draining state.preStart to
  // undefined guarantees no buffered entry is ever relayed twice and that the
  // live patch never re-buffers — start() may fire this more than once but only
  // the first call drains.
  state.flush = (): void => {
    const buffered = state.preStart;
    if (!buffered) {
      return;
    }
    state.preStart = undefined;
    state.preStartBytes = 0;
    for (const item of buffered) {
      relay({ ...item.entry, preStart: true });
    }
  };

  // First install that coincides with start() (no document_start shim existed):
  // go live immediately by draining the empty buffer.
  if (flushOnInstall) {
    state.flush();
  }

  // Single egress used by every patch. Before flush: record into the bounded
  // ring buffer only (the relay path is gated downstream anyway pre-start).
  // After flush: live pass-through.
  const post = (entry: Record<string, unknown>): void => {
    if (state.preStart) {
      const bytes = estimateBytes(entry);
      state.preStart.push({ entry, bytes, atMs: Date.now() });
      state.preStartBytes += bytes;
      evictPreStart();
      return;
    }
    relay(entry);
  };
  const id = (() => {
    let n = 0;
    return () => `shim-${Date.now()}-${(n += 1)}`;
  })();
  // Resolve request URLs to absolute against the page's own location so that
  // relative URLs (fetch("/api/x"), xhr.open("GET","/api/x")) keep a real origin
  // and path downstream. Without this they fail new URL() in the buffer and fall
  // into the "(unknown)" origin bucket. Falls back to the raw value if anything
  // is unparseable (e.g. data:/blob: or an exotic base).
  const absoluteUrl = (raw: string): string => {
    try {
      return new URL(raw, document.baseURI || window.location.href).href;
    } catch {
      return raw;
    }
  };
  const headerPairs = (headers: Headers | undefined): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    if (headers && typeof headers.forEach === "function") {
      headers.forEach((value, key) => pairs.push([key, value]));
    }
    return pairs;
  };

  const originalFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
  if (originalFetch) {
    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
      const started = Date.now();
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = absoluteUrl(rawUrl);
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      let requestBody: string | undefined;
      if (typeof init?.body === "string") {
        requestBody = clip(init.body);
      }
      try {
        const response = await originalFetch(input as RequestInfo, init);
        const clone = response.clone();
        let responseBody: string | undefined;
        try {
          const ct = clone.headers.get("content-type") || "";
          if (/json|text|graphql|javascript|xml/i.test(ct)) {
            responseBody = clip(await clone.text());
          }
        } catch {
          // opaque/streamed bodies are skipped
        }
        post({
          kind: "request",
          id: id(),
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - started,
          requestHeaders: headerPairs(init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit)),
          responseHeaders: headerPairs(response.headers),
          requestBody,
          responseBody
        });
        return response;
      } catch (error) {
        post({
          kind: "request",
          id: id(),
          method,
          url,
          durationMs: Date.now() - started,
          requestHeaders: [],
          responseHeaders: [],
          requestBody
        });
        throw error;
      }
    } as typeof window.fetch;
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;
    type Tracked = XMLHttpRequest & { __shim?: { method: string; url: string; started: number; body?: string } };
    OriginalXHR.prototype.open = function (this: Tracked, method: string, url: string, ...rest: unknown[]) {
      this.__shim = { method: (method || "GET").toUpperCase(), url: absoluteUrl(String(url)), started: Date.now() };
      return open.apply(this, [method, url, ...rest] as never);
    } as typeof OriginalXHR.prototype.open;
    OriginalXHR.prototype.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = this.__shim;
      if (meta && typeof body === "string") {
        meta.body = clip(body);
      }
      this.addEventListener("loadend", () => {
        if (!meta) {
          return;
        }
        let responseBody: string | undefined;
        try {
          if (this.responseType === "" || this.responseType === "text") {
            responseBody = clip(this.responseText);
          }
        } catch {
          // cross-origin or non-text
        }
        post({
          kind: "request",
          id: `shim-xhr-${meta.started}`,
          method: meta.method,
          url: meta.url,
          status: this.status,
          statusText: this.statusText,
          durationMs: Date.now() - meta.started,
          requestHeaders: [],
          responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
          requestBody: meta.body,
          responseBody
        });
      });
      return send.apply(this, [body] as never);
    } as typeof OriginalXHR.prototype.send;
  }

  const OriginalWS = window.WebSocket;
  if (typeof OriginalWS === "function") {
    const PatchedWS = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = protocols === undefined ? new OriginalWS(url) : new OriginalWS(url, protocols);
      const wsUrl = absoluteUrl(typeof url === "string" ? url : url.href);
      const originalSocketSend = socket.send.bind(socket);
      socket.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          post({ kind: "ws", url: wsUrl, direction: "sent", payload: clip(data) ?? "" });
        }
        return originalSocketSend(data as never);
      };
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") {
          post({ kind: "ws", url: wsUrl, direction: "received", payload: clip(event.data) ?? "" });
        }
      });
      return socket;
    } as unknown as typeof WebSocket;
    PatchedWS.prototype = OriginalWS.prototype;
    window.WebSocket = PatchedWS;
  }

  // --- Console + page-error capture --------------------------------------------
  // Console entries flow through the SAME post()/ring-buffer/flush path as
  // network, so console output emitted during page load (before start()) is
  // buffered and flushed with preStart:true exactly like requests. The "kind"
  // distinguishes them downstream; the service worker routes console-kind
  // entries to the console buffer.

  const MAX_CONSOLE_MSG = 2_000;
  const clipMsg = (value: string): string =>
    value.length > MAX_CONSOLE_MSG ? value.slice(0, MAX_CONSOLE_MSG) : value;

  // Shallow-stringify console args. We deliberately do NOT walk deep object
  // graphs: objects become a one-level "[object Type]"-ish JSON attempt, marked
  // truncated when it overflows. Errors keep their message + stack.
  const serializeArg = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value === null) {
      return "null";
    }
    if (value === undefined) {
      return "undefined";
    }
    const t = typeof value;
    if (t === "number" || t === "boolean" || t === "bigint") {
      return String(value);
    }
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }
    try {
      // Shallow JSON: nested objects/arrays are stringified at most one level by
      // JSON.stringify's default behavior; functions/symbols drop out.
      const json = JSON.stringify(value);
      if (typeof json === "string") {
        return json.length > MAX_CONSOLE_MSG ? `${json.slice(0, MAX_CONSOLE_MSG)}[…truncated]` : json;
      }
    } catch {
      // Circular or non-serializable: fall through to a shallow tag.
    }
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unserializable]";
    }
  };

  // Best-effort top stack frame, cheaply: skip the shim's own frames.
  const topFrame = (stack: string | undefined): string | undefined => {
    if (!stack) {
      return undefined;
    }
    const lines = stack.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/patchedConsole|shimType|installNetworkShim/.test(line)) {
        continue;
      }
      if (/^at\s|@/.test(line)) {
        return line.length > 300 ? line.slice(0, 300) : line;
      }
    }
    return lines[0] ? (lines[0].length > 300 ? lines[0].slice(0, 300) : lines[0]) : undefined;
  };

  const consoleLevels: Array<"log" | "info" | "warn" | "error" | "debug"> = [
    "log",
    "info",
    "warn",
    "error",
    "debug"
  ];
  const consoleRef = window.console as unknown as Record<string, unknown> | undefined;
  if (consoleRef) {
    for (const level of consoleLevels) {
      const original = consoleRef[level];
      if (typeof original !== "function") {
        continue;
      }
      const originalFn = (original as (...args: unknown[]) => unknown).bind(consoleRef);
      consoleRef[level] = function patchedConsole(...args: unknown[]) {
        try {
          const message = clipMsg(args.map(serializeArg).join(" "));
          let stack: string | undefined;
          try {
            stack = new Error().stack ?? undefined;
          } catch {
            stack = undefined;
          }
          post({
            kind: "console",
            level,
            message,
            stack,
            source: topFrame(stack)
          });
        } catch {
          // Never let capture break the page's own console call.
        }
        return originalFn(...args);
      };
    }
  }

  try {
    window.addEventListener("error", (event: ErrorEvent) => {
      try {
        const error = event.error as Error | undefined;
        const message = clipMsg(
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(event.message || "Uncaught error")
        );
        post({
          kind: "page-error",
          level: "error",
          subtype: "error",
          message,
          stack: error instanceof Error ? error.stack : undefined,
          source: topFrame(error instanceof Error ? error.stack : undefined),
          fileName: event.filename,
          lineNumber: event.lineno,
          columnNumber: event.colno
        });
      } catch {
        // best-effort
      }
    });

    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      try {
        const reason = event.reason as unknown;
        const message = clipMsg(
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : `Unhandled promise rejection: ${serializeArg(reason)}`
        );
        post({
          kind: "page-error",
          level: "error",
          subtype: "unhandledrejection",
          message,
          stack: reason instanceof Error ? reason.stack : undefined,
          source: topFrame(reason instanceof Error ? reason.stack : undefined)
        });
      } catch {
        // best-effort
      }
    });
  } catch {
    // addEventListener unavailable (non-window context): skip page-error capture.
  }

  function parseRawHeaders(raw: string): Array<[string, string]> {
    return raw
      .trim()
      .split(/[\r\n]+/)
      .map((line) => {
        const idx = line.indexOf(":");
        return idx === -1 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] as [string, string];
      })
      .filter((pair): pair is [string, string] => pair !== null);
  }
}
