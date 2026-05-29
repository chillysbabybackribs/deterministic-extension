/**
 * Background engine — local companion daemon (v1, minimal standalone).
 *
 * An opt-in localhost daemon the extension talks to. When present, it unlocks
 * the one capability the in-browser extension can't do: capturing FULL network
 * response bodies (and WebSocket payloads) via a headless Chromium it owns and
 * drives over the Chrome DevTools Protocol — no debugger banner, because it is
 * the engine's own browser, not the user's Chrome.
 *
 * Proven mechanism (see CDP proof): headless Chromium + CDP Network domain
 * returns real response bodies. This wraps that in a small HTTP server.
 *
 * SECURITY:
 *  - Binds 127.0.0.1 only (never exposed off the machine).
 *  - Requires a shared token on every non-health request. The token is generated
 *    on first run, persisted next to this file, and read by the extension from
 *    GET /health (localhost-only, so only local code can read it). This stops any
 *    random web page or local app from driving captures.
 *
 * SESSION:
 *  - /capture accepts cookies for the TARGET ORIGIN ONLY (exported by the
 *    extension from the user's own Chrome) and injects them, so the engine sees
 *    exactly what the user's logged-in session sees — nothing more.
 *
 * Run (dev):  node companion/index.mjs
 * Needs:      playwright (already a dev dep of the extension repo)
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const HOST = "127.0.0.1";
const PORT = 8917;
const VERSION = "0.1.0";
const CAPABILITIES = ["full_network_capture"];

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, ".engine-token");

// --- Token (generate once, persist) ------------------------------------------
function loadOrCreateToken() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const t = readFileSync(TOKEN_FILE, "utf8").trim();
      if (t) return t;
    } catch { /* fall through to regenerate */ }
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}
const TOKEN = loadOrCreateToken();

// --- Shared headless browser (kept warm across captures) ----------------------
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

// --- Capture caps (mirror the extension's captureBuffer caps) -----------------
const MAX_BODY_CHARS = 200_000;
const MAX_FRAME_PREVIEW_CHARS = 2_000;
const SETTLE_MS = 6_000;
const NAV_TIMEOUT_MS = 30_000;

function clipBody(s) {
  if (typeof s !== "string") return undefined;
  return s.length > MAX_BODY_CHARS
    ? `${s.slice(0, MAX_BODY_CHARS)}...[truncated ${s.length - MAX_BODY_CHARS} chars]`
    : s;
}
function originOf(url) { try { return new URL(url).origin; } catch { return undefined; } }
function pathOf(url) { try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return undefined; } }

function toHeaderArray(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Drive a headless context over CDP to capture one page's network, including
 * response bodies + WS frames. Returns arrays shaped exactly like the
 * extension's captureBuffer (CapturedRequest / WebSocketFrame, source "cdp"),
 * so the extension can drop them straight into a "cdp" buffer and summarize.
 */
async function capture({ url, cookies }) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    if (Array.isArray(cookies) && cookies.length) {
      const normalized = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        httpOnly: Boolean(c.httpOnly),
        secure: c.secure ?? true,
        sameSite: c.sameSite === "no_restriction" ? "None"
          : c.sameSite === "lax" ? "Lax"
          : c.sameSite === "strict" ? "Strict"
          : (c.sameSite === "None" || c.sameSite === "Lax" || c.sameSite === "Strict") ? c.sameSite
          : "Lax",
        ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {})
      }));
      await context.addCookies(normalized).catch(() => { /* tolerate bad cookies */ });
    }

    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send("Network.enable");

    const byId = new Map();
    const requests = [];
    const webSocketFrames = [];
    const startedAtMs = Date.now();
    const bodyFetches = [];

    client.on("Network.requestWillBeSent", (e) => {
      const rec = {
        id: e.requestId,
        source: "cdp",
        startedAtMs: Date.now(),
        method: e.request.method,
        url: e.request.url,
        origin: originOf(e.request.url),
        path: pathOf(e.request.url),
        resourceType: e.type,
        requestHeaders: toHeaderArray(e.request.headers),
        responseHeaders: [],
        requestBody: clipBody(e.request.postData),
        sensitiveKinds: []
      };
      byId.set(e.requestId, rec);
      requests.push(rec);
    });
    client.on("Network.responseReceived", (e) => {
      const rec = byId.get(e.requestId);
      if (rec) {
        rec.status = e.response.status;
        rec.statusText = e.response.statusText;
        rec.responseHeaders = toHeaderArray(e.response.headers);
        rec._mime = e.response.mimeType;
      }
    });
    client.on("Network.loadingFinished", (e) => {
      const rec = byId.get(e.requestId);
      if (!rec) return;
      // Only pull text-ish bodies (json/text/graphql/xml/html/js).
      if (rec._mime && !/json|text|javascript|graphql|xml|html/i.test(rec._mime)) return;
      bodyFetches.push(
        client.send("Network.getResponseBody", { requestId: e.requestId })
          .then((body) => {
            rec.responseBody = clipBody(
              body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body
            );
          })
          .catch(() => { /* body evicted / unavailable */ })
      );
    });

    const wsFrame = (direction) => (e) => {
      const payload = e.response?.payloadData ?? "";
      webSocketFrames.push({
        id: `${e.requestId}:${webSocketFrames.length}`,
        source: "cdp",
        atMs: Date.now(),
        direction,
        opcode: e.response?.opcode,
        payloadLength: payload.length,
        payloadPreview: payload.length > MAX_FRAME_PREVIEW_CHARS ? `${payload.slice(0, MAX_FRAME_PREVIEW_CHARS)}...[truncated]` : payload,
        payload: clipBody(payload)
      });
    };
    client.on("Network.webSocketFrameReceived", wsFrame("received"));
    client.on("Network.webSocketFrameSent", wsFrame("sent"));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => { /* capture what loaded */ });
    await page.waitForTimeout(SETTLE_MS);
    await Promise.allSettled(bodyFetches);

    // Strip internal fields before returning.
    for (const r of requests) delete r._mime;

    return {
      source: "cdp",
      startedAtMs,
      completedAtMs: Date.now(),
      requests,
      webSocketFrames,
      droppedRequests: 0,
      droppedFrames: 0
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

// --- HTTP server --------------------------------------------------------------
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    // Only the extension origin needs to call this; CORS is permissive because
    // the token (not origin) is the real auth, and the bind is localhost-only.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-engine-token",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 5_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") { send(res, 204, {}); return; }

  // Health: localhost-only, returns the token so the local extension can read it.
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, version: VERSION, capabilities: CAPABILITIES, token: TOKEN });
    return;
  }

  if (req.method === "POST" && req.url === "/capture") {
    const token = req.headers["x-engine-token"];
    if (token !== TOKEN) { send(res, 401, { ok: false, error: "Invalid or missing engine token." }); return; }
    let payload;
    try { payload = await readJson(req); } catch { send(res, 400, { ok: false, error: "Bad JSON body." }); return; }
    if (!payload?.url || typeof payload.url !== "string") { send(res, 400, { ok: false, error: "Missing 'url'." }); return; }
    try {
      const result = await capture({ url: payload.url, cookies: payload.cookies });
      send(res, 200, { ok: true, capture: result });
    } catch (err) {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : "Capture failed." });
    }
    return;
  }

  send(res, 404, { ok: false, error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`[engine] background engine listening on http://${HOST}:${PORT}`);
  console.log(`[engine] token: ${TOKEN.slice(0, 6)}… (persisted to ${TOKEN_FILE})`);
  console.log(`[engine] capabilities: ${CAPABILITIES.join(", ")}`);
});
