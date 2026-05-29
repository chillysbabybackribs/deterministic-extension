# Chrome Extension Readiness Checklist

Current as of May 11, 2026.

## Implemented In This Repository

- Manifest V3 is declared in `public/manifest.json`.
- Extension and action icons are declared in the manifest.
- API calls are pinned to Anthropic's official Messages API endpoint.
- Release builds omit sourcemaps unless `VITE_SOURCEMAP=1` is set.
- `npm run package:extension` builds and validates `dist/`, then writes a Chrome Web Store zip under `release/`.
- A privacy policy draft exists in `PRIVACY.md`.
- A Chrome Web Store listing draft exists in `docs/chrome-web-store-listing.md`.
- Workspace access is limited to a user-selected folder. Workspace connections request read/write permission by default, and writes stay scoped to the selected folder.
- No obvious `eval`, `new Function`, or remote script loading pattern was found during the May 11, 2026 audit.

## Still Needed Before Publication

- Host the final privacy policy at a stable public URL and use the same claims in the Chrome Web Store privacy practices form.
- Prepare Web Store screenshots, promotional images, category, and support URL.
- Review every permission and host permission against the extension's single purpose.
- Confirm that `history` and broad `http://*/*` host access remain deferred for the first Chrome Web Store submission.
- Add a final reviewer-facing explanation for model tool calls: the model can request only locally defined tool names, the extension enforces a local allowlist, and sensitive actions are gated by settings and Chrome permissions.
- Choose and add a project license before public redistribution.
- Run `npm run verify`, `npm run test:extension`, and `npm run package:extension` on the release machine before uploading.

## Current Permission Rationale Draft

- `storage`: saves settings, chat history, run state, and evidence summaries locally.
- `sidePanel`: provides the extension's primary chat interface.
- `tabs`: reads tab metadata, opens/navigates tabs, and coordinates user-requested browser work.
- `tabGroups`: creates titled Chrome tab groups from user-requested tab organization commands.
- `scripting`: extracts visible page content from tabs for user-requested reading and research.
- `search`: uses Chrome search for user-requested web research.
- `https://api.anthropic.com/*`: sends authenticated model requests directly to Anthropic.
- `https://*/*`: allows page inspection and browser research across user-requested HTTPS websites.

## Release Command

```sh
npm run package:extension
```

The generated zip is ignored by git and is intended to be uploaded through the Chrome Web Store Developer Dashboard.
