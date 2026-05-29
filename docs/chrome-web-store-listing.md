# Chrome Web Store Listing Draft

Current as of May 11, 2026.

## Name

Browser Chat Assistant

## Short Description

A Chrome side-panel assistant for browser research, page reading, tab actions, and optional local workspace questions.

## Single Purpose

Browser Chat Assistant helps the user ask questions about their active browser context, perform web research, and inspect an explicitly connected local workspace folder through a chat-first side panel.

## Detailed Description Draft

Browser Chat Assistant adds a chat side panel to Chrome. It can inspect the current HTTPS tab, search the web, extract page content, organize tabs into Chrome tab groups when asked, and synthesize grounded answers from collected evidence. Users can also connect a local workspace folder to ask questions about selected project files. Workspace access is opt-in and limited to the folder the user chooses. Workspace write access requires browser read/write permission and can be switched off in Settings.

The extension sends model requests directly to Anthropic's Messages API using the user's Anthropic API key. Chat history and settings are stored locally in the user's Chrome profile.

## Permission Justifications

- `storage`: saves settings, chat history, run state, and evidence summaries locally.
- `sidePanel`: provides the chat interface.
- `tabs`: reads tab metadata and performs user-requested tab actions.
- `tabGroups`: creates titled Chrome tab groups for user-requested tab organization.
- `scripting`: extracts page content from tabs for reading and research.
- `search`: starts user-requested web searches.
- `https://api.anthropic.com/*`: sends authenticated model requests to Anthropic.
- `https://*/*`: supports page inspection and research across user-requested HTTPS websites.

## Privacy Practices Draft

- The extension does not sell user data.
- The extension does not use user data for advertising.
- The extension stores API keys, settings, chat history, run state, evidence summaries, and optional selected workspace folder handles locally in the user's Chrome profile.
- The extension may transmit chat messages, selected HTTPS page content, tool results, search evidence, and selected workspace snippets to Anthropic when needed to answer the user's request.
- Browser history is not requested or read in the first Chrome Web Store release.
- Optional selected-folder workspace access. The assistant can only access the folder the user chooses. Write access is off unless enabled.

## Store Assets Still Needed

- 128 px store icon from `public/icons/icon-128.png` or a polished replacement.
- At least one Chrome Web Store screenshot.
- Optional small promotional tile.
- Public privacy policy URL.
- Support email or support website.
