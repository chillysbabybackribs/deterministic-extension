/**
 * Client for the opt-in local companion ("background engine").
 *
 * The companion is a localhost daemon the user installs to unlock capabilities
 * the extension sandbox forbids (headless-Chromium CDP capture, etc.). The
 * extension never installs or starts it — it only DETECTS whether it's running
 * (a /health ping) and, when present, routes capability requests to it.
 *
 * Everything here degrades silently: if the daemon isn't installed, every call
 * resolves to "not available" and the extension uses its in-browser tiers. The
 * localhost host permissions (http://localhost/*, http://127.0.0.1/*) are
 * already declared in the manifest, so the fetch is allowed when the daemon is
 * up and blocked/failed (→ not available) when it isn't.
 */

const COMPANION_BASE = "http://127.0.0.1:8917";
const HEALTH_TIMEOUT_MS = 1_200;

export type CompanionHealth = {
  connected: boolean;
  /** Daemon-reported version, when connected. */
  version?: string;
  /** Capability names the daemon advertises (forward-compatible). */
  capabilities?: string[];
  /**
   * Shared token the daemon returns over its localhost-only /health endpoint.
   * Required on every /capture call. Only local code can read it (the daemon
   * binds 127.0.0.1), so this is how the extension proves it is the caller.
   */
  token?: string;
};

const DISCONNECTED: CompanionHealth = { connected: false };

/**
 * Ping the companion's /health endpoint. Resolves to {connected:false} on any
 * failure (not installed, not running, blocked, timeout) — never throws, so
 * callers can treat absence as the normal default tier.
 */
export async function checkCompanionHealth(): Promise<CompanionHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${COMPANION_BASE}/health`, {
      method: "GET",
      signal: controller.signal,
      // The daemon is local + trusted-on-presence; no credentials needed.
      cache: "no-store"
    });
    if (!response.ok) {
      return DISCONNECTED;
    }
    const body = (await response.json()) as { ok?: boolean; version?: string; capabilities?: string[]; token?: string };
    if (!body?.ok) {
      return DISCONNECTED;
    }
    return { connected: true, version: body.version, capabilities: body.capabilities, token: body.token };
  } catch {
    return DISCONNECTED;
  } finally {
    clearTimeout(timer);
  }
}

/** Base URL for issuing capability requests once the daemon is confirmed up. */
export function companionBaseUrl(): string {
  return COMPANION_BASE;
}

/** A cookie to inject into the engine's browser (chrome.cookies shape subset). */
export type CompanionCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expirationDate?: number;
};

/**
 * The daemon's /capture payload. requests/webSocketFrames are already shaped
 * like the extension's captureBuffer (source "cdp"); the caller feeds them into
 * a "cdp" buffer and summarizes. Typed loosely here (the shapes live in
 * captureBuffer); the runner casts them on ingest.
 */
export type CompanionCaptureResult = {
  source: "cdp";
  startedAtMs: number;
  completedAtMs: number;
  requests: unknown[];
  webSocketFrames: unknown[];
  droppedRequests: number;
  droppedFrames: number;
};

const CAPTURE_TIMEOUT_MS = 45_000;

/**
 * Drive a full CDP capture through the engine: it loads `url` in its own headless
 * browser with the given cookies injected, captures requests + response bodies +
 * WS frames, and returns them in captureBuffer shape. Throws on any failure so
 * the caller can fall back to the in-browser tiers.
 */
export async function captureViaCompanion(args: {
  url: string;
  cookies: CompanionCookie[];
  token: string;
}): Promise<CompanionCaptureResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const response = await fetch(`${COMPANION_BASE}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-engine-token": args.token },
      body: JSON.stringify({ url: args.url, cookies: args.cookies }),
      signal: controller.signal,
      cache: "no-store"
    });
    const body = (await response.json()) as { ok?: boolean; capture?: CompanionCaptureResult; error?: string };
    if (!response.ok || !body?.ok || !body.capture) {
      throw new Error(body?.error ?? `Engine capture failed (HTTP ${response.status}).`);
    }
    return body.capture;
  } finally {
    clearTimeout(timer);
  }
}
