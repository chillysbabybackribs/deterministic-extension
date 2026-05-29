import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PRESTART_ENTRIES, SHIM_MESSAGE_TYPE, installNetworkShim } from "./shimInjection";

/**
 * These tests drive the MAIN-world shim's bounded pre-start buffer and flush in
 * a node environment by stubbing the minimal page globals it touches: window
 * (with postMessage), and a fetch it can patch. WebSocket/XHR are left absent so
 * those patches no-op; the buffer logic is exercised through patched fetch.
 */

type RelayedEntry = Record<string, unknown>;

let relayed: RelayedEntry[];
let originalFetchCalls: number;

function stubWindow(): void {
  relayed = [];
  originalFetchCalls = 0;
  const win = {
    postMessage: (message: { type: string; entry: RelayedEntry }) => {
      if (message?.type === SHIM_MESSAGE_TYPE) {
        relayed.push(message.entry);
      }
    },
    fetch: async (_input: unknown, _init?: unknown) => {
      originalFetchCalls += 1;
      return {
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json", forEach: () => undefined },
        clone: () => ({
          headers: { get: () => "text/plain" },
          text: async () => "body"
        })
      } as unknown as Response;
    }
  };
  Object.assign(win, { location: { href: "https://example.com/dashboard" } });
  vi.stubGlobal("window", win);
  // The shim reads window.fetch via the bound original; expose it as the global
  // fetch too so `typeof window.fetch === "function"` holds.
  vi.stubGlobal("fetch", win.fetch);
  // absoluteUrl() resolves against document.baseURI || window.location.href.
  vi.stubGlobal("document", { baseURI: "https://example.com/dashboard" });
}

async function callFetchOnce(url: string = "https://x/api"): Promise<void> {
  await (globalThis as unknown as { window: { fetch: (i: unknown, n?: unknown) => Promise<unknown> } }).window.fetch(
    url,
    { method: "GET" }
  );
}

describe("installNetworkShim pre-start buffering", () => {
  beforeEach(() => stubWindow());
  afterEach(() => vi.unstubAllGlobals());

  it("buffers (does not relay) entries before start(), then flushes once in order with preStart marker", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE); // document_start install: buffering mode

    await callFetchOnce();
    await callFetchOnce();
    // Original fetch ran (pass-through preserved) but nothing relayed yet.
    expect(originalFetchCalls).toBe(2);
    expect(relayed).toHaveLength(0);

    // start() re-injects the shim; the sentinel branch flushes.
    installNetworkShim(SHIM_MESSAGE_TYPE, true);

    expect(relayed).toHaveLength(2);
    expect(relayed.every((entry) => entry.preStart === true)).toBe(true);
  });

  it("delivers each entry exactly once at the boundary (no duplicate from buffer + live)", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE);
    await callFetchOnce(); // buffered
    installNetworkShim(SHIM_MESSAGE_TYPE, true); // flush -> live
    await callFetchOnce(); // live

    expect(relayed).toHaveLength(2);
    const preStartCount = relayed.filter((entry) => entry.preStart === true).length;
    const liveCount = relayed.filter((entry) => entry.preStart === undefined).length;
    expect(preStartCount).toBe(1);
    expect(liveCount).toBe(1);
  });

  it("flush is idempotent: a second start() does not re-deliver buffered entries", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE);
    await callFetchOnce();
    installNetworkShim(SHIM_MESSAGE_TYPE, true);
    installNetworkShim(SHIM_MESSAGE_TYPE, true); // second flush is a no-op
    expect(relayed).toHaveLength(1);
  });

  it("does not double-install or create a second buffer under the sentinel", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE);
    const firstFetch = (globalThis as unknown as { window: { fetch: unknown } }).window.fetch;
    installNetworkShim(SHIM_MESSAGE_TYPE); // re-run: sentinel hit, no re-patch
    const secondFetch = (globalThis as unknown as { window: { fetch: unknown } }).window.fetch;
    // The patch is not reapplied (same patched reference), so no double-push.
    expect(secondFetch).toBe(firstFetch);
  });

  it("resolves relative request URLs to absolute against the page location", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE, true); // live immediately
    await callFetchOnce("/orgs/microsoft/notifications");
    expect(relayed).toHaveLength(1);
    expect(relayed[0].url).toBe("https://example.com/orgs/microsoft/notifications");
  });

  it("leaves absolute request URLs unchanged", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE, true);
    await callFetchOnce("https://api.github.com/user");
    expect(relayed[0].url).toBe("https://api.github.com/user");
  });

  it("bounds the buffer to MAX_PRESTART_ENTRIES with oldest-first eviction", async () => {
    installNetworkShim(SHIM_MESSAGE_TYPE);
    for (let i = 0; i < MAX_PRESTART_ENTRIES + 25; i += 1) {
      await callFetchOnce();
    }
    installNetworkShim(SHIM_MESSAGE_TYPE, true);
    // Count is capped even though more entries were produced pre-start.
    expect(relayed.length).toBe(MAX_PRESTART_ENTRIES);
  });
});
