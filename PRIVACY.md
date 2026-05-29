# Privacy Policy

Effective date: May 11, 2026

Browser Chat Assistant is a Chrome side-panel extension that helps users inspect browser pages, run web research, and work with an optional local workspace folder through Anthropic's Messages API.

This policy describes the repository's intended data handling behavior. Review and host the final version before publishing the extension in the Chrome Web Store.

## Data The Extension Stores Locally

Browser Chat Assistant stores the following data in the user's Chrome profile:

- Anthropic API key and model/settings preferences in Chrome local storage.
- Chat history, run activity, and evidence summaries in Chrome local storage.
- Optional selected workspace folder handles in IndexedDB after the user explicitly connects a folder.

Browser Chat Assistant now includes a minimal developer-operated backend for authentication and account lookup. That backend stores only the minimum account identifier data needed for account management: an internal user ID, the linked Clerk user ID, email when available, and created/updated timestamps.

## Data Sent To Anthropic

When the user sends a chat message or asks the extension to use browser or workspace tools, the extension may send the following to Anthropic:

- The user's chat messages and recent conversation context.
- Selected HTTPS browser tab metadata, page text, headings, links, snippets, and extracted evidence.
- Search queries and summarized search or page results produced during research.
- Selected local workspace file names, snippets, and synthesized workspace context when the user asks the assistant to use workspace context.
- Tool results needed for the model to answer the user's request.

The user's Anthropic API key is sent to Anthropic as an API authentication header.

## Browser History

The Chrome Web Store v1 release does not request the Chrome `history` permission and does not read browser history.

## Local Workspace Access

Workspace access is opt-in. The user must select a local folder through the browser folder picker before the extension can read workspace files. The extension can access only the selected folder. Workspace content may be sent to Anthropic only when the user asks the assistant to use workspace context.

Workspace write access is requested when the user connects a folder and is limited to that selected folder. File write operations require active browser read/write permission. The assistant must not read or write files outside the selected workspace folder.

## Third Parties

The extension sends model requests directly to Anthropic. Anthropic's handling of submitted API data is governed by Anthropic's applicable API terms and privacy policies.

The extension also sends authenticated account requests to the developer-operated backend for sign-in verification and account lookup. Clerk handles authentication for the extension sign-in flow.

The extension may open search result pages, fetch HTTPS pages, or navigate visible tabs while performing user-requested web research. Those sites may receive ordinary web requests from the user's browser. The Chrome Web Store v1 release does not support reading HTTP pages.

## Data Sale Or Advertising

Browser Chat Assistant does not sell user data and does not use user data for advertising.

## User Control

Users can remove locally stored extension data by clearing the extension's Chrome storage or uninstalling the extension. Users can disconnect workspace access by removing the saved folder permission in Chrome or clearing extension data.

The use of information received from Chrome extension APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Contact

Before publishing, replace this section with the support email or website shown in the Chrome Web Store listing.
