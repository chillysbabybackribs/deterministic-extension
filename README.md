# Browser Chat Assistant

Current as of May 29, 2026.

Browser Chat Assistant is a Chrome Manifest V3 side-panel assistant that connects Anthropic Claude to browser automation, deterministic web research, and an optional local workspace folder. The app is designed for grounded answers: it can inspect tabs and pages, run search-oriented research before synthesis, collect evidence, and answer selected local file questions from a folder the user explicitly connects.

## Audit Snapshot

This README was updated after auditing the repository on May 29, 2026.

- `npm run verify` passes: TypeScript type-checking, 63 Vitest files, 449 tests, and a production Vite build.
- `npm run test:extension` passes locally: the side-panel Playwright smoke test passes and the live research trace test is skipped unless `LIVE_RESEARCH_PIPELINE=1` is set.
- `npm audit --audit-level=moderate` reports 0 vulnerabilities.
- Chrome Web Store readiness notes live in `docs/chrome-extension-readiness.md`; listing copy starts in `docs/chrome-web-store-listing.md`; the privacy-policy draft lives in `PRIVACY.md`.
- The repository currently has no license file.

## What It Does

- Runs a Chrome side-panel chat UI titled `Browser Chat`.
- Calls Anthropic's Messages API directly from the extension runtime.
- Keeps chat history, settings, run activity, and latest evidence in local browser storage.
- Lets Claude Haiku 4.5 use browser tools for tab listing/opening/navigation/grouping, search, page extraction, and page interaction.
- Runs a deterministic, corpus-backed research loop before model synthesis for prompts that need current, external, cited, technical, or comparison information — the model plans the searches and synthesizes the answer, but never reads pages itself.
- Runs deterministic workspace operations for local folder prompts when a workspace is connected.
- Shows live progress, warnings, evidence cards, source coverage, activity, and run controls while long browser or workspace work is active.
- Supports pausing, resuming, and stopping active runs through a Chrome runtime port.

## Model And Provider

The chat loop is currently locked to Anthropic:

- Provider: `anthropic`
- Chat model: `claude-haiku-4-5-20251001`
- Default base URL: `https://api.anthropic.com`
- Default max output tokens: `1600`
- Temperature: `0.2`

The settings panel allows editing the API key, max output tokens, debug logs, evidence preview, workspace connection, workspace write access, and the research synthesis model.

Research synthesis can use:

- `auto`, which keeps Haiku for simpler prompts and escalates to Sonnet for complex ones — comparison, enumeration (`X, Y, and Z` / `X vs Y vs Z`), reasoning, dense, or technical tasks — via the `modelPolicy` complexity classifier.
- `claude-haiku-4-5-20251001`, forced.
- `claude-sonnet-4-6`, forced.

Workspace synthesis uses Haiku by default. If Sonnet is selected for synthesis, multi-operation workspace bundles can use Sonnet as well.

## Browser And Workspace Tools

Claude receives these browser tools during the normal tool loop:

- `browser_read_active_tab`
- `browser_list_tabs`
- `browser_open_tab`
- `browser_group_tabs`
- `browser_navigate_active_tab`
- `browser_observe_page`
- `browser_click`
- `browser_type`
- `browser_select`
- `browser_press_key`
- `browser_scroll_page`
- `browser_wait_for`
- `browser_assert_page`
- `web_search`
- `browser_extract_page`
- `browser_find_in_page`

When a local folder is connected, Claude can also use workspace tools:

- `fs_get_workspace`
- `fs_list_directory`
- `fs_read_file`
- `fs_search_files`
- `fs_write_file`

Workspace paths are relative to the selected folder. Workspace connections request browser read/write permission by default, and file writes are limited to the selected folder.

Page interaction tools follow an observe-then-act pattern. `browser_observe_page` returns deterministic element refs, selectors, roles, labels, visibility, editability, and bounds; action tools then click, type, select, press keys, scroll, wait for conditions, or assert page state against those observed refs or explicit selectors.

## Deterministic Browser Processes

The browser interaction foundation mirrors the deterministic search pipeline: plan first, execute typed tool calls, record trace rows, check completion conditions, then hand only grounded results to synthesis.

The process runner supports preconditions, postconditions, bounded retries, current-tab propagation, audit entries, and aggregate execution output. The optimized starting recipes are:

- `observe-act-verify`: observe the page, perform one action, wait for a postcondition, then assert final state.
- `form-fill-submit`: observe once, batch field edits without repeated observations, submit, then wait/assert success.
- `navigation-guard`: open or navigate, wait for readiness, observe, and validate URL/title/page state.
- `stateful-extract`: change page state, wait for deterministic readiness, extract the resulting content, and verify sufficiency.

## Deterministic Research

Search-style prompts run through a deterministic, corpus-backed research loop before the model answers. The model is used in exactly two places — planning the searches and synthesizing the final answer — never per page. This keeps token usage low and makes the path predictable instead of asking the model to decide whether and how to search.

### Page scan gate

Before any work, a cheap prompt-only gate (`pageScanGate`) decides whether the current page is even relevant:

- A web-research / search prompt (e.g. "research…", "search the web", "compare X vs Y", "latest…") **skips the page scan entirely** and goes straight to the search step. The page the user happens to be sitting on is irrelevant to the research.
- A prompt that targets the current page (deictic "this page", or an interaction verb like click/type/scroll/fill/submit, or an explicit captured-UI selection) **scans** — it runs the actionable overlay and feeds that page map into planning.
- Anything else (a self-contained ask) skips the scan.

The decision is made from the prompt alone. It deliberately does not weigh the current URL against the corpus, because the navigation listener folds every visited page into the corpus — so "is this site known" is true for almost every page and could never say skip.

### The research loop

When a research prompt diverts to the research path:

1. The planner compiles the prompt into one or more `search_web` steps — one per distinct angle or sub-question. It does **not** plan `understand_page` steps to read result links; the loop does that.
2. Each search runs in the background and reuses the **single working tab** — the tab the user already had open — rather than spawning new tabs.
3. Organic result links are extracted from the SERP only (anchors wrapping an `<h3>`), so the search page sees links and nothing else.
4. The loop opens candidate URLs one at a time in that same working tab, pre-warming the next page's navigation while it extracts the current one.
5. Each page is extracted, stripped of boilerplate (cookie/legal/sign-in/link-dumps), split into high-value content sections, and deduplicated across pages by a normalized content key.
6. Cleaned sections are written to the persistent **web corpus** (IndexedDB), which now carries two layers per page entry: the interaction-element map and the research content sections.
7. The model then runs a deterministic corpus retrieval (`rankSectionsAcrossSites`, TF-IDF over the content layer) and receives a single structured summary of verbatim, sourced section text.
8. Synthesis runs once over that structured summary.

If the structured summary is insufficient the pipeline can degrade gracefully to a generic loop, but a healthy pipeline should answer from the first pass — a required second pass means the search pipeline is broken.

The live progress card reports the scan decision, search planning, pages read, sections recalled, warnings, and synthesis status.

## Deterministic Workspace

Workspace prompts are handled before the open-ended model tool loop when they clearly refer to files, folders, paths, the repository, or the local project.

The workspace planner can:

- Check the connected folder and permission state.
- List directories, optionally recursively.
- Read text files with size limits.
- Search file names and readable text content.
- Create or overwrite text files when write access is enabled.

Simple list/read/search/write requests can return directly from deterministic results. Broader workspace questions are synthesized from a clipped workspace bundle without giving the model direct filesystem access during synthesis.

## Project Structure

```text
.
├── public/
│   ├── icons/                       # Generated extension and action icons
│   └── manifest.json
├── docs/                            # Chrome extension readiness notes
├── scripts/                         # Icon generation and release packaging helpers
├── src/
│   ├── app/                         # React side-panel shell and global styles
│   ├── background/                  # MV3 service worker, run control, model/tool orchestration
│   │   └── pipeline/                # Plan→execute→gate→synthesize, page-scan gate, corpus research loop
│   ├── webcorpus/                   # Persistent web corpus: content sections, retrieval, ranking
│   ├── conversation/                # Chat message types and persisted chat history
│   ├── evidence/                    # Evidence packet types and builders
│   ├── execution/                   # Tool and activity result types
│   ├── filesystem/                  # File System Access API workspace store
│   ├── model/                       # Anthropic Messages API client
│   ├── settings/                    # Provider, model, and app settings
│   ├── shared/                      # Runtime protocol and common helpers
│   ├── tools/                       # Browser/workspace tool schemas and executors
│   └── ui/components/               # Chat, drawers, composer, progress, settings
├── tests/extension/                 # Playwright extension smoke and live trace specs
├── PRIVACY.md
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

## Requirements

- Node.js 20 or newer.
- npm.
- Chrome 116 or newer.
- An Anthropic API key.
- Playwright Chromium and `xvfb-run` for extension tests in a headless Linux environment.

The extension uses Chrome APIs that only work inside an installed extension context, including `tabs`, `tabGroups`, `scripting`, `storage`, `sidePanel`, and `search`. Workspace folder access depends on the File System Access API.

## Setup

Install dependencies:

```bash
npm install
```

Run local verification:

```bash
npm run verify
```

Build the extension:

```bash
npm run build
```

If you are enabling Clerk for the extension, copy `.env.example` to `.env` and set:

- `VITE_CLERK_PUBLISHABLE_KEY`
- `CLERK_FRONTEND_API`
- `CRX_PUBLIC_KEY`

`CRX_PUBLIC_KEY` keeps the extension ID stable across rebuilds, which Clerk's Chrome extension flow depends on. `CLERK_FRONTEND_API` is injected into the built manifest so Clerk requests are explicitly allowed by Chrome.

If you are enabling the local backend for authenticated account and billing flows, copy `backend.env.example` to `backend.env` and set:

- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_KEY` when you want offline JWT verification
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`
- `STRIPE_PORTAL_RETURN_URL`

Keep `STRIPE_SECRET_KEY` in the backend env only. Do not add Stripe secret keys to `.env`, Vite env vars, or extension source files.

Package a Chrome Web Store upload zip:

```bash
npm run package:extension
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked."
4. Select the generated `dist/` directory.
5. Click the extension action to open the side panel.
6. Open Settings and paste your Anthropic API key.

## Development

Use Vite for quick React side-panel iteration:

```bash
npm run dev
```

The Vite dev page does not provide the real Chrome extension runtime. For browser APIs, background service worker behavior, and side-panel testing, rebuild and reload the unpacked `dist/` extension from `chrome://extensions`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite on `127.0.0.1`. |
| `npm run typecheck` | Run TypeScript with `tsc --noEmit`. |
| `npm run test` | Run Vitest unit/audit tests under `src/**/*.test.ts`. |
| `npm run generate:icons` | Regenerate checked-in extension PNG icons. |
| `npm run build` | Type-check and build the extension into `dist/`. |
| `npm run build:debug` | Build with sourcemaps by setting `VITE_SOURCEMAP=1`. |
| `npm run verify` | Run type-checking, Vitest, and a production Vite build. |
| `npm run package:extension` | Generate icons, build, validate `dist/`, and write a Web Store zip under `release/`. |
| `npm run preview` | Preview the built Vite app on `127.0.0.1`. |
| `npm run test:pipeline` | Print the deterministic research audit trace fixture with verbose Vitest output. |
| `npm run test:extension` | Build and run Playwright extension tests under Xvfb. |
| `npm run test:pipeline:live` | Run the live browser/search research trace test. This visits the web and does not call the LLM. |

If Playwright cannot find a browser, run:

```bash
npx playwright install chromium
```

You can override the browser binary with:

```bash
PLAYWRIGHT_CHROME_EXECUTABLE=/path/to/chrome npm run test:extension
```

## Configuration Storage

Settings are saved under `ohmygod.settings`.

Default settings:

```ts
{
  provider: {
    provider: "anthropic",
    apiKey: ""
  },
  model: {
    model: "claude-haiku-4-5-20251001",
    researchSynthesisModel: "auto",
    temperature: 0.2,
    maxOutputTokens: 1600
  },
  dev: {
    permissiveExecution: true,
    showDebugLogs: true,
    showEvidencePreview: true
  }
}
```

Chat history is saved under `ohmygod.chatHistory.v2` with migration support for `ohmygod.chatHistory.v1`. Workspace folder handles are saved in IndexedDB under `ohmygod.workspace`.

## Security And Privacy Notes

- Do not commit API keys or local environment files.
- API keys entered in Settings are stored in Chrome local storage and sent as an `x-api-key` header to `https://api.anthropic.com/v1/messages`.
- The Anthropic client sends `anthropic-dangerous-direct-browser-access: true` because calls are made directly from the extension runtime.
- The Chrome Web Store v1 build requests `https://*/*` host permission so it can inspect HTTPS pages and run user-requested browser research.
- Deterministic research opens visible tabs, queries Google through Chrome, may visit search results, and may background-fetch HTTPS pages when visible extraction is thin.
- Chat context, selected browser tool results, deterministic evidence bundles, and synthesized workspace snippets can be sent to Anthropic.
- The Chrome Web Store v1 build does not request browser history permission.
- Workspace access is opt-in through the browser folder picker and limited to the selected folder. Write operations also require the Settings write toggle.
- Release builds omit sourcemaps by default. Use `npm run build:debug` when you intentionally need build sourcemaps.
- The publishable privacy policy draft is in `PRIVACY.md`; Chrome Web Store readiness tracking is in `docs/chrome-extension-readiness.md`; listing copy starts in `docs/chrome-web-store-listing.md`.
- `dist/`, `release/`, browser profiles, test output, logs, `.env*`, credentials, private keys, certificates, `.crx` packages, zip packages, and `node_modules/` are ignored by git.

Review permissions and provider settings before distributing the extension beyond local development.

## Troubleshooting

### "Add an Anthropic API key in settings before using Haiku 4.5."

Open Settings in the side panel and paste a valid Anthropic API key.

### "Chrome extension runtime is not available."

The app is being opened outside the extension runtime. Build the extension and load `dist/` through `chrome://extensions`.

### "This Chrome context does not support folder access."

Workspace folder access depends on the File System Access API. Use a supported Chrome extension context and connect the folder from Settings.

### Search or extraction produces thin evidence

Some pages block automated extraction, require sign-in, show CAPTCHA, or require JavaScript. The research runner records blocked or thin sources and continues through additional candidates until it reaches sufficiency or exhausts the search plan.

### The live research trace test is skipped

`tests/extension/research-trace.live.spec.ts` only runs when `LIVE_RESEARCH_PIPELINE=1` is set. Use `npm run test:pipeline:live` when you intentionally want a live browser/search trace.

## License

No license file is currently included. Add one before publishing if you want to define how others may use or redistribute this code.
