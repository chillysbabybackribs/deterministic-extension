---
name: new-browser-tool
description: Scaffold a new Claude browser/fs tool end-to-end — the tool module, its colocated Vitest spec, and all four wiring points (name union, schema, executor dispatch). Use when adding a `browser_*`, `fs_*`, or `web_*` tool to src/tools.
---

# new-browser-tool

Scaffold a new Claude tool in `src/tools/` following this repo's house style. A tool
is only complete when **all four wiring points** below are done — a missing one is a
type error (the `BrowserToolName` union and executor `switch` are exhaustive) or a
silently-unavailable tool.

## When to use

The user wants to add a new tool the model can call (e.g. `browser_<verb>`,
`fs_<verb>`, `web_<verb>`). Ask for, or infer from the request:

- **Tool name** — `snake_case`, prefixed `browser_` / `fs_` / `web_` to match siblings.
- **One-line purpose** — becomes the schema `description` the model reads to decide
  when to call it. Write it for the model, not for humans (see existing entries like
  `browser_capture_network` for the level of operational detail that pays off).
- **Inputs** — each with JSON-schema type; mark required ones.
- **What it returns / does** — drives the module body and the test.

## The four wiring points

All in `src/tools/`. Edit them in this order so the type checker guides you.

### 1. Name union — `browserToolList.ts`
Add the literal to the `BrowserToolName` union:
```ts
export type BrowserToolName =
  | "browser_read_active_tab"
  | ...
  | "browser_<verb>";   // <-- add here
```

### 2. Schema entry — `browserToolList.ts`, `HAIKU_BROWSER_TOOLS`
Append an `AnthropicToolSchema`. Always set `additionalProperties: false`. List
`required` fields. Give each non-obvious property a `description` — the model only
sees this, never the implementation:
```ts
{
  name: "browser_<verb>",
  description: "<one line, written for the model: what it does + when to use it>.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["<requiredArg>"],
    properties: {
      <requiredArg>: { type: "string", description: "<why/what>." },
      tabId: { type: "number", description: "Target tab id from browser_list_tabs." }
    }
  }
}
```

### 3. Executor dispatch — `browserToolExecutor.ts`
Add a `case` to the `switch (name)` inside `executeBrowserToolLocally`, delegating to
a handler. Handlers take `input: Record<string, unknown>` and return
`Promise<ToolRuntimeResult>`:
```ts
    case "browser_<verb>":
      return <verb>Handler(input);
```
The handler coerces inputs with the existing helpers (`asBoolean`, `clampNumber`,
etc. — see `readActiveTab`), calls into the tool module, and returns a
`ToolRuntimeResult`. Required fields on that result: `output`, `summary`, `kind`,
`eventType`, `visible`. Optional: `status`, `error`, `warnings`, `evidenceItems`, … —
match what a sibling handler with similar behavior sets.

### 4. Tool module — `src/tools/<toolName>.ts`
The actual logic. Conventions seen across `elementOverlay.ts`, `siteRecon.ts`, etc.:
- Lead with a **block comment** stating purpose, the architecture, and explicitly what
  is **deferred** (clean seams, not built yet). This repo documents intent heavily.
- Export the public types (`export type ...`) the handler and test consume.
- If injecting into the page via `chrome.scripting.executeScript`, the injected
  function must be **fully self-contained** — close over nothing from module scope
  (it's serialized into the page's isolated world); inline constants or pass as args.

## Test (required, colocated)

Every tool ships a `src/tools/<toolName>.test.ts` Vitest spec beside the module —
this is universal here (`elementOverlay.test.ts`, `siteRecon.test.ts`, …). Pattern:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { <publicExports>, type <ResultType> } from "./<toolName>";

// Stub chrome.* the module touches (see elementOverlay.test.ts stubChrome()).
describe("<toolName>", () => {
  it("<behavior>", () => { /* ... */ expect(...).toBe(...); });
});
```
Stub the `chrome` APIs the module calls; assert the structured return shape and edge
cases (empty page, missing tab, dedup/warnings).

## Verify

Run the gate before declaring done:
```bash
npm run typecheck   # catches an unhandled union member / missing case
npm test            # vitest run — the new spec must pass
```
The exhaustive `switch` and union mean a half-wired tool fails `typecheck`; a tool
with no behavior coverage is incomplete by repo convention.
