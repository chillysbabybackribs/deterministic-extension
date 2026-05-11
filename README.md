# Chrome Browser LLM Deterministic

Current as of May 11, 2026.

A Chrome Manifest V3 side-panel assistant that connects Claude Haiku 4.5 to browser automation tools and a deterministic research preflight pipeline. The extension is designed for grounded browser answers: it can read tabs, search the web, inspect pages, manage tabs, collect evidence, and synthesize answers from extracted sources instead of relying only on the model's internal knowledge.

## What It Does

- Runs as a Chrome side-panel chat assistant.
- Uses Anthropic's Messages API directly from the extension runtime.
- Stores provider settings locally in Chrome storage.
- Sends Claude Haiku 4.5 a browser tool list for tab/page/history actions.
- Runs a deterministic research pipeline for search-oriented prompts before the model answers.
- Falls back to deterministic research when the model returns a knowledge-gap answer such as "I don't have specific information..." or "not in my knowledge base."
- Shows live research progress in the UI while searches and source extraction are running.
- Keeps an evidence packet for each run, including tool steps, candidate links, opened sources, warnings, and missing information.

## Current Model And Provider

The app is currently hardwired to Anthropic:

- Provider: `anthropic`
- Model: `claude-haiku-4-5-20251001`
- Default base URL: `https://api.anthropic.com`
- Default max output tokens: `1600`
- Temperature: `0.2`

The model and provider selectors are intentionally locked in the UI right now. The API base URL, API key, max output tokens, debug logs, and evidence preview toggles are configurable in the settings panel.

## Browser Capabilities

The model can request these tools during a normal tool loop:

- `browser_read_active_tab`: read active tab metadata, optional page snapshot, headings, text, and links.
- `browser_list_tabs`: list open tabs.
- `browser_open_tab`: open an HTTP or HTTPS URL.
- `browser_navigate_active_tab`: navigate, reload, go back, or go forward.
- `web_search`: open a Chrome default search results tab and optionally snapshot it.
- `browser_extract_page`: extract readable page text, headings, and links.
- `browser_find_in_page`: find matching passages in a page snapshot.
- `browser_history_search`: search recent browser history.
- `browser_group_tabs`: group selected tabs.
- `browser_close_tabs`: close selected tabs.

Search-style prompts usually bypass the open-ended tool loop and use deterministic research first, which is more predictable than asking the model to decide whether to search.

## Deterministic Research Pipeline

For prompts that look like they need current or external information, the background worker runs a preflight research pass before asking Haiku to write the answer.

The trigger covers:

- Explicit search language: "search", "look up", "latest", "current", "docs", "pricing", "cite", "compare", and similar terms.
- URLs and named sites.
- Social discussion prompts about what users, developers, Reddit, forums, or communities are saying.
- Researchable unfamiliar topic prompts, including short bare topics such as `ADK browser deterministic automation`.
- Knowledge-gap fallback answers from the model.

The pipeline:

1. Compiles the user prompt into a search query.
2. Builds a search intent from prompt terms, named domains, freshness needs, architecture intent, social-discussion intent, and video intent.
3. Opens Google search result pages through a visible browser tab.
4. Ranks and deduplicates candidate links.
5. Rotates one visible tab through ranked sources for extractable content.
6. Uses background fetch as a fallback when visible extraction is thin or blocked.
7. Builds evidence cards with source URLs, selected facts, relevant passages, warnings, and extracted dates when available.
8. Evaluates source sufficiency based on usable sources, domain diversity, relevant passages, freshness, and coverage score.
9. Sends only the evidence bundle to Haiku for final synthesis.

The research UI receives progress events over a Chrome runtime port and displays current status, completed steps, warnings, source URLs, and synthesis state.

## Project Structure

```text
.
├── public/
│   └── manifest.json
├── src/
│   ├── app/                         # React side-panel app shell and styles
│   ├── background/                  # MV3 service worker, tool loop, research runner
│   ├── conversation/                # Chat message types
│   ├── evidence/                    # Evidence packet types
│   ├── execution/                   # Tool/activity result types
│   ├── model/                       # Anthropic Messages API client
│   ├── settings/                    # Provider/model/settings storage
│   ├── shared/                      # Runtime request/response/progress protocol
│   ├── tools/                       # Browser tool schemas and executors
│   └── ui/components/               # Chat, drawers, composer, progress, settings
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Requirements

- Node.js 20 or newer is recommended.
- npm.
- Chrome 116 or newer.
- An Anthropic API key.

The extension uses Chrome APIs that are only available inside an installed extension context, including `tabs`, `tabGroups`, `scripting`, `storage`, `sidePanel`, `history`, and `search`.

## Setup

Install dependencies:

```bash
npm install
```

Type-check the project:

```bash
npm run typecheck
```

Build the extension:

```bash
npm run build
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked."
4. Select the generated `dist/` directory.
5. Click the extension action to open the side panel.
6. Open settings and paste your Anthropic API key.

## Development Workflow

Use the Vite dev command for local frontend iteration:

```bash
npm run dev
```

For real Chrome extension testing, rebuild and reload the unpacked extension:

```bash
npm run build
```

Then press the reload button for the extension on `chrome://extensions`.

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite on `127.0.0.1`. |
| `npm run build` | Build the side panel and background service worker into `dist/`. |
| `npm run typecheck` | Run TypeScript with `tsc --noEmit`. |
| `npm run preview` | Preview the built Vite app on `127.0.0.1`. |

## Configuration

Settings are saved locally under the key `ohmygod.settings`.

The default settings are:

```ts
{
  provider: {
    provider: "anthropic",
    apiKey: "",
    baseUrl: "https://api.anthropic.com"
  },
  model: {
    model: "claude-haiku-4-5-20251001",
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

Do not commit API keys or local environment files. API keys entered in the settings UI are saved in Chrome local storage, not in this repository.

## Security And Privacy Notes

- `.gitignore` excludes `node_modules/`, `dist/`, `.env*`, private keys, certificates, `.crx` packages, logs, local editor settings, browser profiles, and test output.
- The extension currently requests broad host permissions for `http://*/*` and `https://*/*` because page extraction and browser automation can operate across arbitrary pages.
- The extension sends chat context, selected tool results, and deterministic evidence bundles to the configured Anthropic API endpoint.
- Browser history is only queried when the model explicitly uses `browser_history_search`.
- The deterministic research pipeline may open visible browser tabs and visit search results while collecting evidence.
- The Anthropic API key is transmitted as an `x-api-key` header to the configured base URL.

Review permissions and provider settings before distributing the extension beyond local development.

## GitHub Readiness

This repository is configured for:

```bash
git remote add origin https://github.com/chillysbabybackribs/chromeext-browser-llm-deterministic.git
```

Before pushing, run:

```bash
npm run typecheck
npm run build
git status --short --ignored
```

Expected ignored directories include:

```text
!! dist/
!! node_modules/
```

To publish the current branch after reviewing changes:

```bash
git push -u origin main
```

## Known Implementation Notes

- The project is private in `package.json`; that only affects npm publishing, not GitHub pushes.
- `dist/` is generated build output and should not be committed.
- `package-lock.json` should be committed for reproducible npm installs.
- The app title in the UI is currently "Browser Chat" with the subtitle "V2 scaffold."
- The current implementation assumes Anthropic direct browser access headers are acceptable for this local extension workflow.

## Troubleshooting

### "Add an Anthropic API key in settings before using Haiku 4.5."

Open the side-panel settings and paste a valid Anthropic API key.

### "Chrome extension runtime is not available."

The app is being opened outside the Chrome extension runtime. Build the extension and load `dist/` through `chrome://extensions`.

### Search or extraction produces thin evidence

Some pages block automated extraction, require sign-in, show CAPTCHA, or require JavaScript. The research runner marks those pages as blocked or thin and continues through additional candidates until it reaches sufficiency limits.

### The model says it does not know an unfamiliar topic

The current code retries those knowledge-gap answers through deterministic research. If this still happens, inspect the Activity and Evidence drawers to see whether the search pipeline failed, produced thin sources, or exhausted candidate pages.

## License

No license file is currently included. Add one before publishing if you want to define how others may use or redistribute the code.
