# Chrome Extension Audit

## 1. Executive summary

- Browser Chat Assistant is a Chrome MV3 side-panel extension. The manifest declares MV3, an action button, a module background service worker, a side panel, Chrome API permissions, optional debugger access, and broad HTTPS host access (`public/manifest.json:2`, `public/manifest.json:16`, `public/manifest.json:28`, `public/manifest.json:32`, `public/manifest.json:35`, `public/manifest.json:44`, `public/manifest.json:47`).
- The extension lets a signed-in user chat with model providers, inspect current pages, run browser research, interact with tabs/pages, capture network traffic, and use an optional local workspace folder. The side panel loads React through `src/app/index.html`, `src/main.tsx`, and `src/app/App.tsx` (`src/app/index.html:11`, `src/main.tsx:7`, `src/app/App.tsx:68`).
- Overall health is decent: code is TypeScript, Vite-built, and heavily tested. On the verification pass, `npm run typecheck` passed, but `npm test` currently fails 1 of 331 tests in the master-router fallback suite (`src/background/masterRouter.test.ts:466`). Test configuration is in `vitest.config.ts:3` and `playwright.config.ts:3`.
- Top risk 1: `https://*/*` gives the extension all HTTPS hosts. It is relied on for arbitrary page inspection, research, script injection, fallback HTTPS fetches, and Gemini routing, but it also makes every HTTPS origin available to extension code (`public/manifest.json:52`, `src/tools/pageSnapshot.ts:107`, `src/background/deterministicResearchRunner.ts:2068`, `src/model/geminiRouterClient.ts:47`).
- Top risk 2: raw network dumps can expose unredacted credentials to the tool loop. The code intentionally tags but does not mask sensitive values, and the dump action returns request bodies/headers by default (`src/tools/networkCapture/captureBuffer.ts:8`, `src/tools/networkCapture/browserCaptureNetwork.ts:214`, `src/tools/networkCapture/browserCaptureNetwork.ts:239`, `src/tools/browserToolList.ts:570`).
- Top risk 3: page actions are enabled by default through `DEV_PERMISSIVE_EXECUTION = true`, so model-selected click/type/select/keypress tools can run on arbitrary HTTPS pages unless the user disables them (`src/settings/settingsStore.ts:15`, `src/settings/settingsStore.ts:32`, `src/tools/browserToolExecutor.ts:415`).
- The `cookies` permission appears over-broad: no `chrome.cookies` API usage exists; the only cookie collection I found reads page-visible `document.cookie` names inside an injected page inspection script (`public/manifest.json:36`, `src/tools/browserToolExecutor.ts:3374`).

## 2. File tree

Generated with `node_modules`, `dist`, `server/dist`, `build`, `out`, `coverage`, `release`, `test-results`, and `.git` pruned. Local secret/state files are included because they are relevant to the audit.

```text
.
.claude
.env
.env.example
.gitignore
.keys
.keys/chrome-extension-private-key.pem
AGNETS.md
BILLING_FOUNDATION_PHASE_0_REPORT.md
PRIVACY.md
README.md
STRIPE_PHASE_1_BACKEND_REPORT.md
STRIPE_READINESS_AUDIT.md
backend.env.example
docs
docs/chrome-extension-readiness.md
docs/chrome-web-store-listing.md
docs/stripe-webhooks.md
package-lock.json
package.json
playwright.config.ts
public
public/icons
public/icons/browser-chat-assistant-icon-source.svg
public/icons/icon-128.png
public/icons/icon-16.png
public/icons/icon-256.png
public/icons/icon-32.png
public/icons/icon-48.png
public/icons/icon-512.png
public/icons/icon-96.png
public/manifest.json
public/slim19.png
scripts
scripts/generate-icons.mjs
scripts/package-extension.mjs
scripts/patch-inspection-dispatch.mjs
server
server/data
server/data/test-health.sqlite
server/data/test-health.sqlite-shm
server/data/test-health.sqlite-wal
server/src
server/src/app.test.ts
server/src/app.ts
server/src/billing.test.ts
server/src/billing.ts
server/src/clerkAuth.ts
server/src/env.ts
server/src/index.ts
server/src/types.ts
server/src/userStore.ts
server/src/webhook.test.ts
server/src/webhook.ts
server/tsconfig.json
src
src/app
src/app/App.test.ts
src/app/App.tsx
src/app/AppShell.tsx
src/app/index.html
src/app/styles.css
src/auth
src/auth/ClerkAuth.tsx
src/auth/backendClient.test.ts
src/auth/backendClient.ts
src/auth/clerkSessionStorage.test.ts
src/auth/clerkSessionStorage.ts
src/auth/extensionUrl.test.ts
src/auth/extensionUrl.ts
src/auth/useBackendApiClient.ts
src/background
src/background/deterministicBrowserProcessRunner.test.ts
src/background/deterministicBrowserProcessRunner.ts
src/background/deterministicNetworkCaptureRunner.test.ts
src/background/deterministicNetworkCaptureRunner.ts
src/background/deterministicPageInspectionRunner.test.ts
src/background/deterministicPageInspectionRunner.ts
src/background/deterministicResearchRunner.test.ts
src/background/deterministicResearchRunner.ts
src/background/deterministicWorkspaceRunner.test.ts
src/background/deterministicWorkspaceRunner.ts
src/background/haikuToolRunner.mixed.test.ts
src/background/haikuToolRunner.observability.test.ts
src/background/haikuToolRunner.test.ts
src/background/haikuToolRunner.tokenBounds.test.ts
src/background/haikuToolRunner.ts
src/background/masterRouter.test.ts
src/background/masterRouter.ts
src/background/mixedDeterministicRunner.test.ts
src/background/mixedDeterministicRunner.ts
src/background/pageAppInspectionIntent.ts
src/background/research
src/background/research/candidates.ts
src/background/research/evidenceCards.ts
src/background/research/executionAdapter.ts
src/background/research/formatting.ts
src/background/research/intent.ts
src/background/research/ledger.test.ts
src/background/research/ledger.ts
src/background/research/requestedEvidence.ts
src/background/research/searchPlans.ts
src/background/research/sourceClassifier.ts
src/background/research/sourceSnapshots.ts
src/background/research/sufficiency.ts
src/background/research/trace.ts
src/background/research/types.ts
src/background/research/visibleSelection.ts
src/background/researchPipeline.audit.test.ts
src/background/runControl.test.ts
src/background/runControl.ts
src/background/serviceWorker.ts
src/build
src/build/manifestConfig.test.ts
src/build/manifestConfig.ts
src/conversation
src/conversation/conversationStore.test.ts
src/conversation/conversationStore.ts
src/conversation/conversationTypes.ts
src/evidence
src/evidence/evidenceBuilders.ts
src/evidence/evidenceTypes.ts
src/execution
src/execution/executionTypes.ts
src/filesystem
src/filesystem/workspaceStore.test.ts
src/filesystem/workspaceStore.ts
src/image-viewer
src/image-viewer/index.html
src/image-viewer/main.ts
src/image-viewer/styles.css
src/main.tsx
src/model
src/model/anthropicToolClient.test.ts
src/model/anthropicToolClient.ts
src/model/componentGenerationRequest.test.ts
src/model/componentGenerationRequest.ts
src/model/geminiRouterClient.ts
src/settings
src/settings/modelSettings.ts
src/settings/providerSettings.ts
src/settings/settingsStore.test.ts
src/settings/settingsStore.ts
src/shared
src/shared/asyncUtils.ts
src/shared/id.ts
src/shared/protocol.ts
src/shared/textUtils.ts
src/shared/urlUtils.test.ts
src/shared/urlUtils.ts
src/tools
src/tools/browserToolExecutor.test.ts
src/tools/browserToolExecutor.ts
src/tools/browserToolList.test.ts
src/tools/browserToolList.ts
src/tools/chromeTabs.ts
src/tools/componentTemplatePlanner.test.ts
src/tools/componentTemplatePlanner.ts
src/tools/networkCapture
src/tools/networkCapture/browserCaptureNetwork.ts
src/tools/networkCapture/captureBuffer.test.ts
src/tools/networkCapture/captureBuffer.ts
src/tools/networkCapture/cdpCapture.ts
src/tools/networkCapture/pageShimCapture.test.ts
src/tools/networkCapture/pageShimCapture.ts
src/tools/pageCapture.test.ts
src/tools/pageCapture.ts
src/tools/pageInteraction.test.ts
src/tools/pageInteraction.ts
src/tools/pageSnapshot.test.ts
src/tools/pageSnapshot.ts
src/tools/searchBlocker.test.ts
src/tools/searchBlocker.ts
src/tools/workspaceMapper.test.ts
src/tools/workspaceMapper.ts
src/ui
src/ui/components
src/ui/components/ActivityDrawer.tsx
src/ui/components/ActivityPanel.tsx
src/ui/components/ChatHistoryDrawer.tsx
src/ui/components/ChatWindow.tsx
src/ui/components/Composer.tsx
src/ui/components/EvidenceDrawer.tsx
src/ui/components/EvidencePreview.tsx
src/ui/components/GeneratedComponentPreview.tsx
src/ui/components/MarkdownMessage.tsx
src/ui/components/MessageList.test.ts
src/ui/components/MessageList.tsx
src/ui/components/ResearchProgressCard.test.ts
src/ui/components/ResearchProgressCard.tsx
src/ui/components/SettingsPanel.tsx
src/ui/components/ToolStatus.test.ts
src/ui/components/ToolStatus.tsx
src/ui/components/generatedComponentPreviewModel.test.ts
src/ui/components/generatedComponentPreviewModel.ts
src/vite-env.d.ts
testing0190.md
tests
tests/extension
tests/extension/progress-ui.spec.ts
tests/extension/research-trace.live.spec.ts
tests/extension/serviceworker-progress.spec.ts
tests/extension/sidepanel.smoke.spec.ts
tsconfig.json
vite.config.ts
vitest.config.ts
```

## 3. Orientation

The located manifest is `public/manifest.json`. It declares `"manifest_version": 3`, so this is MV3 (`public/manifest.json:2`). It declares a module background service worker at `background/serviceWorker.js` (`public/manifest.json:28`) and a side panel at `src/app/index.html` (`public/manifest.json:32`).

The build system is Vite plus React and custom Rollup/Vite extension wiring. `package.json` defines `dev`, `build`, `build:fast`, `build:debug`, `package:extension`, `test`, `typecheck`, and extension Playwright scripts (`package.json:7`). `vite.config.ts` uses `@vitejs/plugin-react`, defines Rollup inputs for the side panel, image viewer, and service worker, emits the service worker as `background/serviceWorker.js`, and writes to `dist` (`vite.config.ts:3`, `vite.config.ts:34`, `vite.config.ts:40`, `vite.config.ts:46`). A custom `extension-manifest-plugin` rewrites `dist/manifest.json` after bundling to inject Clerk host permission and optional CRX public key (`vite.config.ts:7`, `vite.config.ts:12`, `src/build/manifestConfig.ts:20`, `src/build/manifestConfig.ts:24`).

The extension is bundled by `npm run build`, which runs `npm run typecheck && vite build` (`package.json:13`). Release packaging runs icons, build, and `scripts/package-extension.mjs`; that script validates the built manifest, checks MV3, checks icons, checks service worker/side-panel files, strips `manifest.key`, and writes a zip under `release` (`package.json:17`, `scripts/package-extension.mjs:52`, `scripts/package-extension.mjs:56`, `scripts/package-extension.mjs:71`, `scripts/package-extension.mjs:82`, `scripts/package-extension.mjs:168`). The README says to load the generated `dist/` directory in Chrome via `chrome://extensions` (`README.md:220`, `README.md:225`).

## 4. Component inventory

### Background service worker / background page

Exists. The manifest entry is `background/serviceWorker.js` with `"type": "module"` (`public/manifest.json:28`). The source entry is `src/background/serviceWorker.ts` through the Vite Rollup input named `serviceWorker` (`vite.config.ts:36`, `vite.config.ts:37`).

It sets side panel action-button behavior on install (`src/background/serviceWorker.ts:34`). It accepts trusted internal runtime messages for `ohmygod.run` and `ohmygod.researchTrace`, then calls `runHaikuToolChat` or the deterministic research trace helper (`src/background/serviceWorker.ts:38`, `src/background/serviceWorker.ts:43`, `src/background/serviceWorker.ts:61`, `src/background/serviceWorker.ts:75`). It also accepts a named runtime port, streams progress and answer deltas, handles pause/resume/stop control, and delegates workspace filesystem tools back to the side panel (`src/background/serviceWorker.ts:91`, `src/background/serviceWorker.ts:122`, `src/background/serviceWorker.ts:151`, `src/background/serviceWorker.ts:252`).

### Content scripts

No static content scripts exist in the manifest. There is no `content_scripts` key in `public/manifest.json`; the manifest object ends after `host_permissions` (`public/manifest.json:47`, `public/manifest.json:53`). Therefore there are no static `matches` patterns and no static `run_at` timing.

The code does use dynamic scripting with `chrome.scripting.executeScript` when a user/tool path needs page access. Examples include page snapshots (`src/tools/pageSnapshot.ts:107`), page observation/action/condition scripts (`src/tools/pageInteraction.ts:119`, `src/tools/pageInteraction.ts:141`, `src/tools/pageInteraction.ts:155`), UI capture (`src/tools/pageCapture.ts:357`), image-search extraction and page-app inspection (`src/tools/browserToolExecutor.ts:2097`, `src/tools/browserToolExecutor.ts:2111`), Google result extraction (`src/background/deterministicResearchRunner.ts:1980`), and network capture shims (`src/tools/networkCapture/pageShimCapture.ts:74`, `src/tools/networkCapture/pageShimCapture.ts:82`).

### Popup, options page, side panel, devtools page, new-tab override

Popup: absent. The manifest has an `"action"` with title/icons but no `default_popup` (`public/manifest.json:16`, `public/manifest.json:27`).

Side panel: exists. The manifest points to `src/app/index.html` (`public/manifest.json:32`). That HTML loads `/src/main.tsx` (`src/app/index.html:11`), and `src/main.tsx` renders `ClerkAuthProvider`, `App`, and `ClerkUserControls` (`src/main.tsx:7`, `src/main.tsx:9`, `src/main.tsx:10`). The app loads settings/chat/workspace state and drives chat, browser tools, and workspace actions (`src/app/App.tsx:68`, `src/app/App.tsx:108`, `src/app/App.tsx:201`).

Options page: absent. There is no `options_page` or `options_ui` key in the manifest (`public/manifest.json:1` through `public/manifest.json:54`). Settings are implemented inside the side panel (`src/ui/components/SettingsPanel.tsx:59`).

Devtools page: absent. There is no `devtools_page` key in the manifest (`public/manifest.json:1` through `public/manifest.json:54`).

New-tab override: absent. There is no `chrome_url_overrides` key in the manifest (`public/manifest.json:1` through `public/manifest.json:54`).

Other extension page: `src/image-viewer/index.html` is not manifest-declared but is bundled as a Rollup input and opened by `fs_open_image` through `chrome.runtime.getURL` (`vite.config.ts:36`, `src/tools/browserToolExecutor.ts:1542`, `src/tools/browserToolExecutor.ts:1543`). It reads an image from the selected workspace and renders it via an object URL (`src/image-viewer/main.ts:13`, `src/image-viewer/main.ts:20`, `src/image-viewer/main.ts:21`).

### Injected/world scripts

MAIN world: exists only for network shim capture. `startPageShimCapture` injects `installNetworkShim` with `world: "MAIN"` across all frames; that function monkey-patches `fetch`, `XMLHttpRequest`, and `WebSocket` and posts captured metadata back through `window.postMessage` (`src/tools/networkCapture/pageShimCapture.ts:81`, `src/tools/networkCapture/pageShimCapture.ts:82`, `src/tools/networkCapture/pageShimCapture.ts:188`, `src/tools/networkCapture/pageShimCapture.ts:220`, `src/tools/networkCapture/pageShimCapture.ts:270`, `src/tools/networkCapture/pageShimCapture.ts:314`).

ISOLATED world: exists for the network shim bridge and all unspecified `chrome.scripting.executeScript` calls. The bridge is injected with `world: "ISOLATED"` and relays page `postMessage` events to `chrome.runtime.sendMessage` (`src/tools/networkCapture/pageShimCapture.ts:72`, `src/tools/networkCapture/pageShimCapture.ts:74`, `src/tools/networkCapture/pageShimCapture.ts:165`, `src/tools/networkCapture/pageShimCapture.ts:172`, `src/tools/networkCapture/pageShimCapture.ts:181`). Page snapshots, page interactions, page app inspection, UI capture, image search extraction, and Google result extraction omit `world`, so they use Chrome's default isolated world (`src/tools/pageSnapshot.ts:107`, `src/tools/pageInteraction.ts:119`, `src/tools/pageCapture.ts:357`, `src/tools/browserToolExecutor.ts:2111`, `src/background/deterministicResearchRunner.ts:1980`).

### Offscreen documents

No offscreen documents exist. There is no `offscreen` manifest key and no `chrome.offscreen` usage in source (`public/manifest.json:1` through `public/manifest.json:54`).

## 5. Permissions audit

### Declared permissions and matches

`permissions`: `cookies`, `tabs`, `tabGroups`, `scripting`, `storage`, `sidePanel`, `search` (`public/manifest.json:35`).

`optional_permissions`: `debugger` (`public/manifest.json:44`).

`host_permissions`: `https://api.anthropic.com/*`, `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*`, `https://*/*` (`public/manifest.json:47`).

`content_scripts.matches`: none, because there are no static content scripts (`public/manifest.json:1` through `public/manifest.json:54`).

### Permission usage

`cookies`: requested but I found no `chrome.cookies` API usage in source. Cookie names are read through `document.cookie` inside page inspection and values are explicitly not captured (`src/tools/browserToolExecutor.ts:3374`, `src/tools/browserToolExecutor.ts:3400`, `src/background/deterministicPageInspectionRunner.ts:245`). This is over-permissioning unless there is a future feature not present in the code.

`tabs`: actively used for listing tabs, opening tabs, navigating/reloading, reading active tabs, search/research tab rotation, and image viewer tabs (`src/tools/browserToolExecutor.ts:587`, `src/tools/browserToolExecutor.ts:610`, `src/tools/browserToolExecutor.ts:734`, `src/background/deterministicResearchRunner.ts:1012`, `src/tools/browserToolExecutor.ts:1544`).

`tabGroups`: actively used by `browser_group_tabs`; the code checks `chrome.tabGroups.update`, groups tab IDs with `chrome.tabs.group`, then updates group title/color (`src/tools/browserToolExecutor.ts:654`, `src/tools/browserToolExecutor.ts:655`, `src/tools/browserToolExecutor.ts:685`, `src/tools/browserToolExecutor.ts:688`).

`scripting`: actively used for page extraction, observation/actions, UI capture, page app inspection, image search extraction, Google result extraction, and network shims (`src/tools/pageSnapshot.ts:107`, `src/tools/pageInteraction.ts:119`, `src/tools/pageCapture.ts:357`, `src/tools/browserToolExecutor.ts:2111`, `src/background/deterministicResearchRunner.ts:1980`, `src/tools/networkCapture/pageShimCapture.ts:74`).

`storage`: actively used for app settings, chat history, and Clerk session cache in `chrome.storage.local` (`src/settings/settingsStore.ts:44`, `src/settings/settingsStore.ts:58`, `src/conversation/conversationStore.ts:69`, `src/conversation/conversationStore.ts:78`, `src/auth/clerkSessionStorage.ts:41`, `src/auth/clerkSessionStorage.ts:61`). I found no `chrome.storage.sync` or `chrome.storage.session` usage.

`sidePanel`: actively used to open the panel when the action button is clicked (`src/background/serviceWorker.ts:34`, `src/background/serviceWorker.ts:35`).

`search`: actively used by the `web_search` tool through `chrome.search.query` with `disposition: "NEW_TAB"` (`src/tools/browserToolExecutor.ts:1108`, `src/tools/browserToolExecutor.ts:1120`, `src/tools/browserToolExecutor.ts:1122`).

`debugger` optional permission: actively requested and used by network capture. The CDP path checks/requests `debugger`, attaches to a tab, enables the Network domain, listens for events, and uses `Network.getResponseBody` (`src/tools/networkCapture/cdpCapture.ts:44`, `src/tools/networkCapture/cdpCapture.ts:53`, `src/tools/networkCapture/cdpCapture.ts:67`, `src/tools/networkCapture/cdpCapture.ts:89`, `src/tools/networkCapture/cdpCapture.ts:101`, `src/tools/networkCapture/cdpCapture.ts:208`).

`https://api.anthropic.com/*`: actively used for Anthropic Messages API calls. The extension sends model request bodies plus an `x-api-key` header to `https://api.anthropic.com/v1/messages` (`src/model/anthropicToolClient.ts:76`, `src/model/anthropicToolClient.ts:101`, `src/model/anthropicToolClient.ts:104`, `src/model/anthropicToolClient.ts:393`, `src/model/anthropicToolClient.ts:396`).

`http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*`: relied on for localhost URLs and local backend development. URL validation allows HTTP only for localhost, 127.0.0.1, and `[::1]` (`src/shared/urlUtils.ts:10`, `src/shared/urlUtils.ts:11`). The backend client defaults to `http://127.0.0.1:8787` and calls `/api/me`, checkout, portal, and entitlement endpoints with a Clerk bearer token (`src/auth/backendClient.ts:34`, `src/auth/backendClient.ts:38`, `src/auth/backendClient.ts:46`, `src/auth/backendClient.ts:57`, `src/auth/backendClient.ts:69`, `src/auth/backendClient.ts:94`, `src/auth/backendClient.ts:97`).

`https://*/*`: broad host permission. It is relied on for arbitrary HTTPS page injection and research/fetching: page snapshots and page app inspection inject into target tabs (`src/tools/pageSnapshot.ts:107`, `src/tools/browserToolExecutor.ts:2111`), deterministic research opens and rotates arbitrary HTTPS tabs (`src/background/deterministicResearchRunner.ts:1316`, `src/background/deterministicResearchRunner.ts:1397`), background fetch fallback normalizes to HTTPS and fetches with credentials omitted (`src/background/deterministicResearchRunner.ts:2056`, `src/background/deterministicResearchRunner.ts:2068`, `src/background/deterministicResearchRunner.ts:2070`), and Gemini routing calls `https://generativelanguage.googleapis.com/...` under this broad permission (`src/model/geminiRouterClient.ts:22`, `src/model/geminiRouterClient.ts:47`, `src/model/geminiRouterClient.ts:50`).

Over-permissioning found: `cookies` is requested but unused as a Chrome API. Broad `https://*/*` is functional, not unused, but it is the largest permission risk. `https://api.anthropic.com/*` is redundant while `https://*/*` remains present, but it would be useful if host access were narrowed.

## 6. Architecture and data flow

### Message-passing graph

- Side panel -> service worker via `chrome.runtime.connect({ name: "ohmygod.run" })`: sends `ohmygod.run` requests with user message, settings, history, and optional active capture context; receives progress, answer deltas, keepalives, workspace tool requests, and final response (`src/app/App.tsx:1004`, `src/app/App.tsx:1039`, `src/app/App.tsx:1053`, `src/app/App.tsx:1103`, `src/background/serviceWorker.ts:91`, `src/background/serviceWorker.ts:151`, `src/background/serviceWorker.ts:156`, `src/background/serviceWorker.ts:160`).
- Side panel -> service worker via `chrome.runtime.sendMessage`: fallback non-streaming `ohmygod.run` request path; service worker validates sender and returns one `RunResponse` (`src/app/App.tsx:1014`, `src/app/App.tsx:1015`, `src/background/serviceWorker.ts:38`, `src/background/serviceWorker.ts:57`, `src/background/serviceWorker.ts:61`, `src/background/serviceWorker.ts:67`).
- Side panel -> service worker over the same port: pause/resume/stop control messages of type `ohmygod.control` (`src/app/App.tsx:1041`, `src/app/App.tsx:1043`, `src/background/serviceWorker.ts:128`, `src/background/serviceWorker.ts:134`).
- Service worker -> side panel over the same port: `ohmygod.workspace_tool_request` asks the side panel to execute workspace filesystem tools locally; side panel replies with `ohmygod.workspace_tool_response` (`src/background/serviceWorker.ts:252`, `src/background/serviceWorker.ts:260`, `src/app/App.tsx:1075`, `src/app/App.tsx:1076`, `src/app/App.tsx:1078`, `src/app/App.tsx:1083`).
- MAIN-world page shim -> ISOLATED-world bridge -> service worker: the MAIN shim posts network entries with `window.postMessage`, the isolated bridge receives them and calls `chrome.runtime.sendMessage`, and the service-worker-side listener ingests them into the active capture buffer (`src/tools/networkCapture/pageShimCapture.ts:199`, `src/tools/networkCapture/pageShimCapture.ts:201`, `src/tools/networkCapture/pageShimCapture.ts:172`, `src/tools/networkCapture/pageShimCapture.ts:181`, `src/tools/networkCapture/pageShimCapture.ts:104`, `src/tools/networkCapture/pageShimCapture.ts:116`).
- Tests -> service worker: the live research trace Playwright spec sends `ohmygod.researchTrace`; I did not find production UI code that sends this message (`tests/extension/research-trace.live.spec.ts:85`, `src/background/serviceWorker.ts:43`, `src/background/serviceWorker.ts:229`).
- No `chrome.tabs.sendMessage` usage was found.

The service worker only accepts messages/ports from itself or no sender ID, via `isTrustedRuntimeSender` (`src/background/serviceWorker.ts:39`, `src/background/serviceWorker.ts:92`, `src/background/serviceWorker.ts:214`). There is no manifest `externally_connectable`, so web pages do not get an externally declared runtime messaging channel (`public/manifest.json:1` through `public/manifest.json:54`).

### Storage usage

`chrome.storage.local` key `ohmygod.settings`: stores provider settings, API keys, model settings, and dev flags. The key is defined in `settingsStore`, and the shape includes `provider`, `model`, and `dev` (`src/settings/settingsStore.ts:23`, `src/settings/settingsStore.ts:39`, `src/settings/settingsStore.ts:44`, `src/settings/settingsStore.ts:58`). Provider fields include `apiKey`, `geminiApiKey`, and `openaiApiKey` (`src/settings/providerSettings.ts:3`, `src/settings/providerSettings.ts:5`).

`chrome.storage.local` keys `ohmygod.chatHistory.v2` and legacy `ohmygod.chatHistory.v1`: stores active conversation ID, conversations, messages, activity entries, and latest evidence with caps/truncation (`src/conversation/conversationStore.ts:16`, `src/conversation/conversationStore.ts:29`, `src/conversation/conversationStore.ts:42`, `src/conversation/conversationStore.ts:65`, `src/conversation/conversationStore.ts:91`, `src/conversation/conversationStore.ts:119`). It can also remove both current and legacy keys (`src/conversation/conversationStore.ts:76`).

`chrome.storage.local` dynamic Clerk cache keys prefixed `browser-chat-assistant|clerk`: stores Clerk session cache values through `@clerk/chrome-extension`'s `StorageCache` interface (`src/auth/clerkSessionStorage.ts:3`, `src/auth/clerkSessionStorage.ts:6`, `src/auth/clerkSessionStorage.ts:18`, `src/auth/clerkSessionStorage.ts:25`, `src/auth/clerkSessionStorage.ts:41`, `src/auth/clerkSessionStorage.ts:61`).

`localStorage`: used only as a fallback when Chrome storage is unavailable, mainly for tests/non-extension contexts (`src/settings/settingsStore.ts:51`, `src/settings/settingsStore.ts:62`, `src/conversation/conversationStore.ts:73`, `src/conversation/conversationStore.ts:82`, `src/conversation/conversationStore.ts:167`).

IndexedDB: `ohmygod.workspace` database, version 1, object store `workspace`, key `active`. It stores a `WorkspaceRecord` containing a File System Access directory handle, root name, connected timestamp, and schema version (`src/filesystem/workspaceStore.ts:100`, `src/filesystem/workspaceStore.ts:108`, `src/filesystem/workspaceStore.ts:111`, `src/filesystem/workspaceStore.ts:161`, `src/filesystem/workspaceStore.ts:828`, `src/filesystem/workspaceStore.ts:835`, `src/filesystem/workspaceStore.ts:839`). The folder picker requests read/write mode and then persists the handle (`src/filesystem/workspaceStore.ts:143`, `src/filesystem/workspaceStore.ts:152`, `src/filesystem/workspaceStore.ts:156`).

Target page storage inspection: injected page app inspection can read target page `localStorage`/`sessionStorage` key names and, only if requested, short value previews; deterministic page inspection sets `includeStorageValues: false` so values do not go to the model in that path (`src/tools/browserToolExecutor.ts:3336`, `src/tools/browserToolExecutor.ts:3358`, `src/tools/browserToolExecutor.ts:3362`, `src/background/deterministicPageInspectionRunner.ts:28`, `src/background/deterministicPageInspectionRunner.ts:32`).

Backend storage, not extension storage: the repo contains an optional Express backend that stores user and Stripe subscription state in SQLite through `better-sqlite3` (`server/src/userStore.ts:3`, `server/src/userStore.ts:21`, `server/src/userStore.ts:221`, `server/src/userStore.ts:239`). The default backend DB path is `./server/data/app.sqlite` (`server/src/env.ts:22`).

### External network calls

Anthropic: `callAnthropicMessage` and `streamAnthropicMessage` POST to `https://api.anthropic.com/v1/messages` with `x-api-key`, Anthropic version headers, system prompt, conversation messages, tools, and generation settings (`src/model/anthropicToolClient.ts:76`, `src/model/anthropicToolClient.ts:101`, `src/model/anthropicToolClient.ts:143`, `src/model/anthropicToolClient.ts:393`, `src/model/anthropicToolClient.ts:396`, `src/model/anthropicToolClient.ts:402`). This can include user prompts, chat history, extracted page text, workspace snippets, research bundles, tool results, and API keys as headers.

Gemini: if a Gemini API key is saved, the master router calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...` with the key in the query string and sends the router system prompt plus the current user message/recent history (`src/background/masterRouter.ts:89`, `src/background/masterRouter.ts:92`, `src/background/masterRouter.ts:265`, `src/model/geminiRouterClient.ts:22`, `src/model/geminiRouterClient.ts:47`, `src/model/geminiRouterClient.ts:56`). The router provider order only uses Gemini when `settings.provider.geminiApiKey` is present (`src/background/masterRouter.ts:360`, `src/background/masterRouter.ts:362`).

Local/backend API: the side panel creates a backend client using `VITE_BACKEND_API_URL` or default `http://127.0.0.1:8787`; it calls `/api/me`, `/api/billing/create-checkout-session`, `/api/billing/create-portal-session`, and `/api/me/entitlements` with a Clerk bearer token (`src/auth/backendClient.ts:34`, `src/auth/backendClient.ts:38`, `src/auth/backendClient.ts:46`, `src/auth/backendClient.ts:57`, `src/auth/backendClient.ts:69`, `src/auth/backendClient.ts:87`, `src/auth/backendClient.ts:97`).

Google/default search: deterministic research builds Google search URLs with the user query in the URL (`src/background/research/candidates.ts:280`, `src/background/research/candidates.ts:282`). The `web_search` tool uses Chrome's default search provider through `chrome.search.query` (`src/tools/browserToolExecutor.ts:1120`). Image search opens `https://www.google.com/search?...tbm=isch&udm=2` in a tab (`src/tools/browserToolExecutor.ts:1265`, `src/tools/browserToolExecutor.ts:2088`).

Arbitrary HTTPS research/source fetches: deterministic research uses visible tabs and background HTTPS fetches for candidate pages. Background fetches normalize HTTP to HTTPS, omit credentials, follow redirects, and request HTML/text content (`src/background/deterministicResearchRunner.ts:1316`, `src/background/deterministicResearchRunner.ts:1397`, `src/background/deterministicResearchRunner.ts:2056`, `src/background/deterministicResearchRunner.ts:2068`, `src/background/deterministicResearchRunner.ts:2070`, `src/background/deterministicResearchRunner.ts:2073`). Snapshot fallback similarly fetches the current HTTPS tab URL with credentials omitted (`src/tools/browserToolExecutor.ts:2221`, `src/tools/browserToolExecutor.ts:2230`, `src/tools/browserToolExecutor.ts:2232`).

Network capture: the extension itself does not create external WebSocket connections, but the MAIN-world shim intercepts page `fetch`, XHR, and WebSocket traffic and stores method, URL, headers, bodies, status, and frames in an in-memory capture buffer (`src/tools/networkCapture/pageShimCapture.ts:188`, `src/tools/networkCapture/pageShimCapture.ts:220`, `src/tools/networkCapture/pageShimCapture.ts:270`, `src/tools/networkCapture/pageShimCapture.ts:314`, `src/tools/networkCapture/captureBuffer.ts:25`).

Backend outbound calls, not extension bundle: the optional backend uses Clerk's backend client to authenticate and fetch a Clerk user (`server/src/clerkAuth.ts:10`, `server/src/clerkAuth.ts:16`, `server/src/clerkAuth.ts:30`) and uses Stripe SDK calls to create customers, checkout sessions, portal sessions, and retrieve subscriptions (`server/src/billing.ts:58`, `server/src/billing.ts:67`, `server/src/billing.ts:104`, `server/src/billing.ts:131`, `server/src/webhook.ts:96`).

## 7. Security review

### CSP and externally_connectable

No `content_security_policy` is declared in the manifest, so there is no explicit unsafe-eval/unsafe-inline/remote-script policy to review in this manifest (`public/manifest.json:1` through `public/manifest.json:54`). The side panel HTML loads a local module script, and Vite bundles it into `dist` (`src/app/index.html:11`, `vite.config.ts:34`). I found no manifest `externally_connectable`; only internal runtime senders are accepted by the service worker (`public/manifest.json:1` through `public/manifest.json:54`, `src/background/serviceWorker.ts:214`).

### Dynamic code and DOM injection

Searches found no source usage of `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, or direct `innerHTML =` in `src`. The message renderer uses `react-markdown` with `skipHtml` and sanitizes links to `http:`, `https:`, or `mailto:` before rendering (`src/ui/components/MarkdownMessage.tsx:89`, `src/ui/components/MarkdownMessage.tsx:92`, `src/ui/components/MarkdownMessage.tsx:99`, `src/ui/components/MarkdownMessage.tsx:101`). The image viewer uses `textContent` and `replaceChildren`, not HTML string injection (`src/image-viewer/main.ts:49`, `src/image-viewer/main.ts:51`, `src/image-viewer/main.ts:52`).

One small UI caveat: generated preview links render `href={stringProp(state, "href") || "#"}` without URL scheme sanitation, though normal clicks are prevented (`src/ui/components/GeneratedComponentPreview.tsx:423`, `src/ui/components/GeneratedComponentPreview.tsx:427`, `src/ui/components/GeneratedComponentPreview.tsx:428`). This is a low-risk preview surface, but sanitizing would keep it consistent with `MarkdownMessage`.

### Secrets and credentials

The extension stores user-supplied Anthropic, Gemini, and OpenAI API key fields in Chrome local storage (`src/settings/providerSettings.ts:3`, `src/settings/providerSettings.ts:5`, `src/settings/settingsStore.ts:58`). The OpenAI key is collected/stored in UI but I did not find an OpenAI network client using it (`src/ui/components/SettingsPanel.tsx:231`, `src/ui/components/SettingsPanel.tsx:236`, `src/ui/components/SettingsPanel.tsx:247`).

The working tree contains `.env` with `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API`, and `CRX_PUBLIC_KEY` keys, and `.keys/chrome-extension-private-key.pem` contains a private key header. I am not reproducing values here. `.gitignore` ignores `.env`, `.env.*`, PEM/key files, and server data (`.env:1`, `.env:2`, `.env:3`, `.keys/chrome-extension-private-key.pem:1`, `.gitignore:11`, `.gitignore:12`, `.gitignore:16`, `.gitignore:48`). `git ls-files` did not show `.env` or `.keys/chrome-extension-private-key.pem` as tracked, but their presence on disk is still operationally sensitive.

The network capture buffer explicitly tags but does not mask credentials (`src/tools/networkCapture/captureBuffer.ts:8`, `src/tools/networkCapture/captureBuffer.ts:151`). Summary output excludes actual values and tells the user to run an explicit dump for values (`src/background/deterministicNetworkCaptureRunner.ts:278`, `src/background/deterministicNetworkCaptureRunner.ts:283`), but the `browser_capture_network` dump tool returns raw entries with bodies by default and warns only after projecting them (`src/tools/networkCapture/browserCaptureNetwork.ts:214`, `src/tools/networkCapture/browserCaptureNetwork.ts:232`, `src/tools/networkCapture/browserCaptureNetwork.ts:239`).

### Injection/trust boundaries

The extension injects into user-requested tabs using broad HTTPS host permission and tool routing. Page-mutating tools are blocked only when `allowPageActions` is false; the default setting makes permissive execution true (`src/settings/settingsStore.ts:15`, `src/settings/settingsStore.ts:32`, `src/tools/browserToolExecutor.ts:415`). The type tool refuses password and file inputs (`src/tools/pageInteraction.ts:637`, `src/tools/pageInteraction.ts:642`), and safe page exploration tries to classify risky controls (`src/tools/browserToolExecutor.ts:2754`), but direct click/type/select/keypress tools can still operate on arbitrary allowed pages when routed.

The network page-shim bridge trusts same-window `postMessage` data by checking `event.source === window` and a fixed message type, but it does not use a random nonce, origin check, or deep schema validation of the entry before forwarding to the service worker (`src/tools/networkCapture/pageShimCapture.ts:172`, `src/tools/networkCapture/pageShimCapture.ts:173`, `src/tools/networkCapture/pageShimCapture.ts:176`, `src/tools/networkCapture/pageShimCapture.ts:181`, `src/tools/networkCapture/pageShimCapture.ts:157`). Any page script in an actively captured tab can forge entries with the known message type and pollute capture results.

## 8. Code health

### Dependencies

Runtime dependencies declared in `package.json` are `@clerk/backend`, `@clerk/chrome-extension`, `better-sqlite3`, `cors`, `express`, `lucide-react`, `react`, `react-dom`, `react-markdown`, `remark-gfm`, `stripe`, and `supertest` (`package.json:26`). Extension runtime imports use `@clerk/chrome-extension`, React/ReactDOM, lucide-react, react-markdown, and remark-gfm (`src/auth/ClerkAuth.tsx:1`, `src/main.tsx:1`, `src/main.tsx:2`, `src/ui/components/SettingsPanel.tsx:1`, `src/ui/components/MarkdownMessage.tsx:1`, `src/ui/components/MarkdownMessage.tsx:2`). Backend runtime imports use `@clerk/backend`, better-sqlite3, cors, express, and stripe (`server/src/clerkAuth.ts:1`, `server/src/userStore.ts:3`, `server/src/app.ts:1`, `server/src/app.ts:2`, `server/src/billing.ts:1`).

`supertest` is declared under runtime dependencies but appears only in backend tests, so it should move to `devDependencies` (`package.json:38`, `server/src/app.test.ts:1`).

As of this audit date, `npm outdated --json` showed runtime updates for `@clerk/backend` 3.4.7 -> 3.4.14, `@clerk/chrome-extension` 3.1.24 -> 3.1.31, `better-sqlite3` 12.9.0 -> 12.10.0, and `stripe` 22.1.1 -> 22.2.0. It also showed dev/tooling updates for `@playwright/test` 1.59.1 -> 1.60.0, `@types/node` 20.19.40 -> 20.19.41 wanted / 25.9.1 latest, `@types/react` 18.3.28 -> 18.3.29 wanted / 19.2.15 latest, `@vitejs/plugin-react` 6.0.1 -> 6.0.2, `tsx` 4.21.0 -> 4.22.3, `vite` 8.0.12 -> 8.0.14, and `vitest` 4.1.6 -> 4.1.7. It showed major-latest lines for React/ReactDOM 18.3.1 installed vs 19.2.6 latest, `@types/react-dom` 18.3.7 vs 19.2.3 latest, lucide-react 0.468.0 vs 1.17.0 latest, and TypeScript 5.9.3 vs 6.0.3 latest. `npm view ... deprecated` returned no deprecation field for the queried runtime packages.

`npm audit` was attempted twice but did not produce output and consumed CPU until stopped; I did not make a current vulnerability claim from it.

### Dead code, comments, TODO/FIXME/HACK

I found no `TODO`, `FIXME`, or `HACK` markers in non-build source. A likely dead/temporary maintenance artifact is `scripts/patch-inspection-dispatch.mjs`: it describes a one-shot patch for earlier edit attempts and writes directly into `src/background/haikuToolRunner.ts`, but it is not referenced from `package.json` scripts (`scripts/patch-inspection-dispatch.mjs:1`, `scripts/patch-inspection-dispatch.mjs:5`, `scripts/patch-inspection-dispatch.mjs:12`, `scripts/patch-inspection-dispatch.mjs:197`, `package.json:7` through `package.json:24`).

OpenAI API key UI/settings appear unused by any OpenAI client. The provider settings include `openaiApiKey`, and settings UI stores it, but no OpenAI network client or model route was found (`src/settings/providerSettings.ts:7`, `src/ui/components/SettingsPanel.tsx:232`, `src/ui/components/SettingsPanel.tsx:236`).

### Service worker restart resilience

Several long-running states are kept only in memory. The run port has local booleans, a `RunControl`, a `pendingWorkspaceTools` map, and a module-global workspace tool delegate (`src/background/serviceWorker.ts:101`, `src/background/serviceWorker.ts:103`, `src/background/serviceWorker.ts:104`, `src/background/serviceWorker.ts:120`, `src/tools/browserToolExecutor.ts:393`). If the MV3 service worker is terminated or restarted during a long run, there is no persisted run state or pending workspace request recovery path.

Network capture state is also in memory: CDP attachments are held in a module map, page-shim active tabs are held in a set, and capture buffers are held in a module map (`src/tools/networkCapture/cdpCapture.ts:38`, `src/tools/networkCapture/pageShimCapture.ts:58`, `src/tools/networkCapture/captureBuffer.ts:81`). A worker restart loses summaries/dumps and can leave the page shim patched until navigation, while the code intentionally cannot unpatch the shim in place (`src/tools/networkCapture/pageShimCapture.ts:92`, `src/tools/networkCapture/pageShimCapture.ts:94`).

Workspace delegated tool requests have no explicit timeout. They are rejected on run finish or port disconnect, but a missing side-panel response can otherwise sit in `pendingWorkspaceTools` while the run waits (`src/background/serviceWorker.ts:257`, `src/background/serviceWorker.ts:259`, `src/background/serviceWorker.ts:272`, `src/background/serviceWorker.ts:286`, `src/background/serviceWorker.ts:172`).

### Tests

Vitest includes source and backend tests via `vitest.config.ts` (`vitest.config.ts:3`, `vitest.config.ts:5`). Playwright extension tests live under `tests/extension` and are configured serially with trace-on-failure (`playwright.config.ts:3`, `playwright.config.ts:4`, `playwright.config.ts:6`, `playwright.config.ts:10`). Existing tests cover storage stores, URL utilities, browser tools, page interaction/snapshot/capture, network capture buffers/page shim, deterministic research/workspace/network/page inspection runners, master routing, UI components, backend client, and server billing/webhooks.

On the verification pass, `npm run typecheck` passed backend and extension TypeScript typechecks. `npm test` did not pass: 41 test files passed, 1 failed; 330 tests passed, 1 failed. The failing assertion is in `src/background/masterRouter.test.ts:466`, where the test expects an unresolved write request to route to `["browser_tool_loop"]` but the current code returns `["deterministic_workspace"]` from `buildHeuristicMasterRoute` (`src/background/masterRouter.ts:133`, `src/background/masterRouter.ts:144`, `src/background/masterRouter.ts:171`).

Missing coverage I would add: manifest permission regression tests that fail on unused `cookies` or accidental broadening, a postMessage spoof test for `pageShimCapture`, a test that raw network dumps redact or require explicit confirmation before being returned to the model, Playwright coverage for service worker restart/port disconnect during an active run, and tests asserting OpenAI key UI is removed or wired to a real provider.

## 9. Findings

| Severity | Issue | Location | Fix |
| --- | --- | --- | --- |
| High | Broad `https://*/*` host permission gives access to all HTTPS pages and is used for injection, research, fallback fetches, and Gemini API calls. | `public/manifest.json:52`, `src/tools/pageSnapshot.ts:107`, `src/background/deterministicResearchRunner.ts:2068`, `src/model/geminiRouterClient.ts:47` | Replace with `activeTab` plus optional host permissions where possible; keep explicit provider hosts like Anthropic/Gemini/Clerk/backend. |
| Medium | Raw network dump returns unredacted credentials and bodies by default. | `src/tools/networkCapture/captureBuffer.ts:8`, `src/tools/networkCapture/browserCaptureNetwork.ts:214`, `src/tools/networkCapture/browserCaptureNetwork.ts:239`, `src/tools/browserToolList.ts:570` | Redact sensitive headers/bodies by default, require explicit user confirmation for raw secrets, and avoid sending raw dumps back into the model loop. |
| Medium | Page-mutating actions are enabled by default. | `src/settings/settingsStore.ts:15`, `src/settings/settingsStore.ts:32`, `src/tools/browserToolExecutor.ts:415` | Default page actions to off or require per-run/per-action confirmation for click/type/select/keypress. |
| Medium | MAIN-world network shim bridge lacks nonce/origin validation and can ingest forged page messages from the active captured page. | `src/tools/networkCapture/pageShimCapture.ts:172`, `src/tools/networkCapture/pageShimCapture.ts:181`, `src/tools/networkCapture/pageShimCapture.ts:157` | Generate a per-capture nonce, validate it in bridge and listener, validate entry schema deeply, and consider checking `event.origin` where meaningful. |
| Medium | Service worker long-run and network-capture state is in memory only; restart loses pending runs/capture buffers. | `src/background/serviceWorker.ts:101`, `src/background/serviceWorker.ts:104`, `src/tools/networkCapture/captureBuffer.ts:81`, `src/tools/networkCapture/cdpCapture.ts:38` | Persist resumable run metadata and capture summaries, add explicit recovery/cleanup on reconnect, and add timeouts for delegated workspace requests. |
| Low | Current unit test suite fails one master-router fallback assertion for unresolved file-write routing. | `src/background/masterRouter.test.ts:466`, `src/background/masterRouter.ts:133`, `src/background/masterRouter.ts:171` | Align `buildHeuristicMasterRoute` with the intended semantic tool-loop behavior, or update the test if deterministic workspace routing is now intended. |
| Low | `cookies` permission appears unused as a Chrome API permission. | `public/manifest.json:36`, `src/tools/browserToolExecutor.ts:3374` | Remove `cookies` unless a `chrome.cookies` feature is added. |
| Low | `supertest` is listed as a runtime dependency but is used only in tests. | `package.json:38`, `server/src/app.test.ts:1` | Move `supertest` to `devDependencies`. |
| Low | OpenAI API key is collected/stored but no OpenAI client path exists. | `src/settings/providerSettings.ts:7`, `src/ui/components/SettingsPanel.tsx:232` | Remove the field or implement the provider; avoid storing unused secrets. |
| Low | One-shot patch script can modify source and appears obsolete. | `scripts/patch-inspection-dispatch.mjs:1`, `scripts/patch-inspection-dispatch.mjs:197` | Delete it or move it to historical notes outside runnable scripts. |
| Low | Private key and `.env` values exist in the working tree, though ignored. | `.keys/chrome-extension-private-key.pem:1`, `.env:1`, `.gitignore:12`, `.gitignore:16` | Keep them out of repos/backups; rotate the private key if this workspace has been shared. |

## 10. Open questions / things not determinable from code alone

- Whether Chrome Web Store reviewers will accept the broad `https://*/*` permission for the intended page inspection/research feature. The code shows why it is used, but policy acceptance depends on review context.
- Whether users are clearly warned before raw network dumps expose credentials. The tool description warns in code, but I did not inspect the final built UX with a live dump flow.
- Whether the `.keys/chrome-extension-private-key.pem` private key has ever been shared, committed elsewhere, or used for production signing. The local file exists and is ignored here, but provenance cannot be determined from code.
- Whether the backend is intended to ship with the extension or remain a developer-operated service. The repo contains both extension and backend code, but only the extension is bundled by Vite.
- Current npm vulnerability status. `npm outdated` and `npm view deprecated` completed, but `npm audit` did not complete during this audit run.
