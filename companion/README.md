# Background engine (local companion daemon)

Optional, opt-in local daemon that gives the extension a capability the in-browser
sandbox forbids: capturing **full network response bodies** (and WebSocket
payloads) from a page, by driving a headless Chromium it owns over the Chrome
DevTools Protocol (CDP). No debugger banner — it's the engine's own browser, not
the user's Chrome.

This is **v1, minimal standalone** — one file, proven end-to-end. Packaging
(signed per-OS installer) and autostart-on-login come later.

## Run (dev)

```sh
# from the repo root (playwright is already a dev dependency)
node companion/index.mjs
```

It listens on `http://127.0.0.1:8917`. The extension auto-detects it via
`GET /health` and routes capture through it when present.

## Endpoints

- `GET /health` → `{ ok, version, capabilities, token }`
  Localhost-only; returns the shared token so the local extension can read it.
- `POST /capture` (header `x-engine-token: <token>`) →
  body `{ url: string, cookies?: Cookie[] }` →
  `{ ok, capture: { source:"cdp", requests:[…], webSocketFrames:[…], … } }`
  `requests`/`webSocketFrames` are shaped exactly like the extension's
  `captureBuffer` (CapturedRequest / WebSocketFrame), so they drop straight into
  a `"cdp"` buffer and summarize unchanged.

## Security

- Binds `127.0.0.1` only — never exposed off the machine.
- Every `/capture` requires the shared **token** (generated on first run,
  persisted to `.engine-token`, gitignored). Stops random web pages / local apps
  from driving captures.
- `cookies` are the **target origin's only**, exported by the extension from the
  user's own Chrome, so the engine sees exactly what the user's session sees —
  nothing more.
