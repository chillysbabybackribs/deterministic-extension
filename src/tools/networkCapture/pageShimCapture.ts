/**
 * Fallback network-capture source: MAIN-world page shim (no chrome.debugger).
 *
 * When the debugger permission is unavailable or CDP can't attach (e.g. DevTools
 * already open on the tab), this path monkey-patches fetch/XMLHttpRequest/
 * WebSocket in the page's MAIN world and relays captured metadata back to the
 * service worker, where it feeds the SAME captureBuffer as the CDP source. The
 * tool contract (start/stop/summary/dump) and the deterministic runner are
 * unchanged — only the `source` differs ("page-shim" vs "cdp").
 *
 * Boundaries vs CDP: the shim only sees what page script can see. It does NOT
 * get pre-injection requests, cross-origin opaque response bodies, or requests
 * the page makes outside the patched globals. It is intentionally visible in
 * behavior (it runs because the user started capture) but shows no Chrome
 * banner — so callers should surface that capture is active in the UI.
 */

import { delay } from "../../shared/asyncUtils";
import {
  addFrame,
  clampBody,
  mergeShimRequest,
  createBuffer,
  detectGraphql,
  framePreview,
  getBuffer,
  originOf,
  pathOf,
  type CaptureBuffer,
  type CapturedHeader
} from "./captureBuffer";
import {
  addConsoleEntry,
  clampConsoleMessage,
  createConsoleBuffer,
  getConsoleBuffer,
  type ConsoleBuffer,
  type ConsoleLevel
} from "./consoleBuffer";
import {
  RELAY_MESSAGE_TYPE,
  SHIM_MESSAGE_TYPE,
  installNetworkShim,
  installShimBridge
} from "./shimInjection";

/**
 * Stable content-script filenames emitted by the build (see vite.config.ts).
 * registerContentScripts requires real bundled files, not inline functions, so
 * the document_start path loads these instead of serializing a func.
 */
const BRIDGE_CONTENT_SCRIPT_FILE = "content/netShimBridge.js";
const MAIN_CONTENT_SCRIPT_FILE = "content/netShimMain.js";
const BRIDGE_CONTENT_SCRIPT_ID = "ohmygod-netshim-bridge";
const MAIN_CONTENT_SCRIPT_ID = "ohmygod-netshim-main";

type ShimRequestEntry = {
  kind: "request";
  id: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  requestBody?: string;
  responseBody?: string;
  /** Set by the shim's flush() for entries buffered before capture started. */
  preStart?: boolean;
};

type ShimFrameEntry = {
  kind: "ws";
  url?: string;
  direction: "sent" | "received";
  payload: string;
  /** Set by the shim's flush() for entries buffered before capture started. */
  preStart?: boolean;
};

type ShimConsoleEntry = {
  kind: "console";
  level: ConsoleLevel;
  message: string;
  stack?: string;
  source?: string;
  /** Set by the shim's flush() for entries buffered before capture started. */
  preStart?: boolean;
};

type ShimPageErrorEntry = {
  kind: "page-error";
  level: "error";
  subtype: "error" | "unhandledrejection";
  message: string;
  stack?: string;
  source?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  /** Set by the shim's flush() for entries buffered before capture started. */
  preStart?: boolean;
};

export type ShimEntry = ShimRequestEntry | ShimFrameEntry | ShimConsoleEntry | ShimPageErrorEntry;

/** Tabs with an active network capture. */
const activeTabs = new Set<number>();
/** Tabs with an active console capture (independent of network). */
const activeConsoleTabs = new Set<number>();
let listenerRegistered = false;

export function isPageShimCapturing(tabId: number): boolean {
  return activeTabs.has(tabId);
}

export function isPageConsoleCapturing(tabId: number): boolean {
  return activeConsoleTabs.has(tabId);
}

export async function startPageShimCapture(tabId: number): Promise<CaptureBuffer> {
  registerListener();
  if (!getBuffer(tabId)) {
    createBuffer(tabId, "page-shim");
  }
  activeTabs.add(tabId);

  // Bridge (ISOLATED world): relays window.postMessage from the MAIN-world shim
  // up to the service worker via chrome.runtime.sendMessage.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: installShimBridge,
    args: [SHIM_MESSAGE_TYPE, RELAY_MESSAGE_TYPE]
  });

  // Shim (MAIN world): monkey-patches fetch/XHR/WebSocket. This is the flush
  // signal for start(): if the document_start shim already installed, the
  // sentinel branch flushes its pre-start ring buffer and switches to live;
  // if no document_start shim ran for this tab, flushOnInstall=true makes this
  // first install go live immediately.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: installNetworkShim,
    args: [SHIM_MESSAGE_TYPE, true]
  });

  return getBuffer(tabId) as CaptureBuffer;
}

export function stopPageShimCapture(tabId: number): void {
  activeTabs.delete(tabId);
  // The injected patches cannot be cleanly un-patched in the page, but once the
  // tab is no longer in activeTabs we drop any further relayed entries, and the
  // patch self-disables on the next navigation (fresh document = no shim).
}

/**
 * Start console capture for a tab. Reuses the SAME shim pipeline as network:
 * the bridge (ISOLATED) + the MAIN-world shim (which now patches console.* and
 * page errors alongside fetch/XHR/WebSocket). Re-running installNetworkShim is
 * the flush signal — the document_start shim drains its pre-start ring buffer
 * (console entries included) marked preStart:true, then goes live.
 */
export async function startPageConsoleCapture(tabId: number): Promise<ConsoleBuffer> {
  registerListener();
  if (!getConsoleBuffer(tabId)) {
    createConsoleBuffer(tabId);
  }
  activeConsoleTabs.add(tabId);

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    func: installShimBridge,
    args: [SHIM_MESSAGE_TYPE, RELAY_MESSAGE_TYPE]
  });

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: installNetworkShim,
    args: [SHIM_MESSAGE_TYPE, true]
  });

  return getConsoleBuffer(tabId) as ConsoleBuffer;
}

export function stopPageConsoleCapture(tabId: number): void {
  activeConsoleTabs.delete(tabId);
}

function registerListener(): void {
  if (listenerRegistered) {
    return;
  }
  listenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isRelayMessage(message)) {
      return;
    }
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }
    const entry = message.entry;

    if (entry.kind === "console" || entry.kind === "page-error") {
      if (!activeConsoleTabs.has(tabId)) {
        return;
      }
      const consoleBuffer = getConsoleBuffer(tabId);
      if (consoleBuffer) {
        ingestConsoleEntry(consoleBuffer, entry);
      }
      return;
    }

    if (!activeTabs.has(tabId)) {
      return;
    }
    const buffer = getBuffer(tabId);
    if (!buffer) {
      return;
    }
    ingestShimEntry(buffer, entry);
  });
}

export function ingestConsoleEntry(buffer: ConsoleBuffer, entry: ShimConsoleEntry | ShimPageErrorEntry): void {
  addConsoleEntry(buffer, {
    id: `console-${Date.now()}-${Math.round(buffer.entries.length)}`,
    kind: entry.kind,
    level: entry.level,
    atMs: Date.now(),
    message: clampConsoleMessage(entry.message),
    stack: entry.stack,
    source: entry.source,
    fileName: entry.kind === "page-error" ? entry.fileName : undefined,
    lineNumber: entry.kind === "page-error" ? entry.lineNumber : undefined,
    columnNumber: entry.kind === "page-error" ? entry.columnNumber : undefined,
    preStart: entry.preStart || undefined
  });
}

export function ingestShimEntry(buffer: CaptureBuffer, entry: ShimEntry): void {
  if (entry.kind === "console" || entry.kind === "page-error") {
    return;
  }
  if (entry.kind === "request") {
    const requestHeaders: CapturedHeader[] = entry.requestHeaders.map(([name, value]) => ({ name, value }));
    const responseHeaders: CapturedHeader[] = entry.responseHeaders.map(([name, value]) => ({ name, value }));
    mergeShimRequest(buffer, {
      id: entry.id,
      source: "page-shim",
      startedAtMs: Date.now(),
      method: entry.method,
      url: entry.url,
      origin: originOf(entry.url),
      path: pathOf(entry.url),
      status: entry.status,
      statusText: entry.statusText,
      durationMs: entry.durationMs,
      requestHeaders,
      responseHeaders,
      requestBody: clampBody(entry.requestBody),
      responseBody: clampBody(entry.responseBody),
      graphql: detectGraphql(entry.url, entry.requestBody),
      sensitiveKinds: [],
      preStart: entry.preStart || undefined
    });
    return;
  }

  addFrame(buffer, {
    id: `${entry.url ?? "ws"}:${Date.now()}:${Math.round(buffer.webSocketFrames.length)}`,
    source: "page-shim",
    atMs: Date.now(),
    url: entry.url,
    direction: entry.direction,
    payloadLength: entry.payload.length,
    payloadPreview: framePreview(entry.payload),
    payload: clampBody(entry.payload),
    preStart: entry.preStart || undefined
  });
}

function isRelayMessage(message: unknown): message is { type: string; entry: ShimEntry } {
  return Boolean(message) && typeof message === "object" &&
    (message as { type?: unknown }).type === RELAY_MESSAGE_TYPE &&
    typeof (message as { entry?: unknown }).entry === "object";
}


/**
 * Register the MAIN-world shim and its ISOLATED bridge to run at document_start
 * on future page loads, so they are installed before the page's own scripts
 * execute (the on-demand executeScript path races page scripts and misses
 * pre-injection activity).
 *
 * Idempotent on two levels: (1) we skip registration if scripts with our IDs
 * already exist, so repeated service-worker startups don't error; (2) the
 * injected functions guard on window-level sentinels (__ohmygodNetShim /
 * __ohmygodShimBridge), so a document_start load and an on-demand injection
 * cannot double-patch the page globals.
 *
 * Also registers the relay listener at startup so entries from already-active
 * tabs are ingested even before the next start() call re-registers it.
 */
export async function ensureShimContentScripts(): Promise<void> {
  registerListener();

  let existingIds: Set<string>;
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: [BRIDGE_CONTENT_SCRIPT_ID, MAIN_CONTENT_SCRIPT_ID]
    });
    existingIds = new Set(registered.map((script) => script.id));
  } catch {
    existingIds = new Set();
  }

  const toRegister: chrome.scripting.RegisteredContentScript[] = [];
  if (!existingIds.has(BRIDGE_CONTENT_SCRIPT_ID)) {
    toRegister.push({
      id: BRIDGE_CONTENT_SCRIPT_ID,
      js: [BRIDGE_CONTENT_SCRIPT_FILE],
      matches: ["https://*/*"],
      runAt: "document_start",
      world: "ISOLATED",
      allFrames: true,
      persistAcrossSessions: true
    });
  }
  if (!existingIds.has(MAIN_CONTENT_SCRIPT_ID)) {
    toRegister.push({
      id: MAIN_CONTENT_SCRIPT_ID,
      js: [MAIN_CONTENT_SCRIPT_FILE],
      matches: ["https://*/*"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
      persistAcrossSessions: true
    });
  }

  if (toRegister.length === 0) {
    return;
  }

  try {
    await chrome.scripting.registerContentScripts(toRegister);
  } catch {
    // A concurrent registration may have won the race (duplicate-id error);
    // the scripts are present either way, so this is safe to ignore.
  }
}

/**
 * Resolve once BOTH document_start shim scripts are confirmed registered, or the
 * timeout elapses. Awaiting registerContentScripts() alone is not enough to
 * guarantee a *subsequent* navigation will carry the shim on a cold service
 * worker — so we poll getRegisteredContentScripts until the ids actually appear.
 * Callers that are about to trigger a load (e.g. the capture reload) gate on this
 * so the new document loads with the shim present, closing the cold-start race.
 *
 * Returns true when both ids are present, false if the timeout was hit first.
 */
export async function waitForShimContentScriptsReady(timeoutMs = 3_000, pollMs = 100): Promise<boolean> {
  const needed = [BRIDGE_CONTENT_SCRIPT_ID, MAIN_CONTENT_SCRIPT_ID];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let present = new Set<string>();
    try {
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: needed });
      present = new Set(registered.map((script) => script.id));
    } catch {
      present = new Set();
    }
    if (needed.every((id) => present.has(id))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(pollMs);
  }
}
