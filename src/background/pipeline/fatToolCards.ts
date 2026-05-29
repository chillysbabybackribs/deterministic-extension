/**
 * Fat-tool cards — the corpus the planner reads to build a plan.
 *
 * Each card describes one fat tool in plain language (what it does, when to use
 * it, what args it needs). The model plans against these cards; a validation
 * pass then checks each planned step against them, so the planner can neither
 * hallucinate a tool nor emit malformed args. Adding a tool = adding a card.
 *
 * NOTE: cards intentionally use the obvious tool names (understand_page, …) that
 * map 1:1 to the fat tools in src/tools/fat/.
 */

import type { FatToolName } from "../../tools/fat/fatToolTypes";

export type FatToolArg = {
  name: string;
  type: "string" | "number" | "string[]" | "step[]";
  required: boolean;
  description: string;
};

export type FatToolCard = {
  tool: FatToolName;
  obvious_name: string;
  what_it_does: string;
  when_to_use: string;
  when_not_to_use: string;
  produces: string;
  args: FatToolArg[];
};

export const FAT_TOOL_CARDS: FatToolCard[] = [
  {
    tool: "understand_page",
    obvious_name: "Understand the current page",
    what_it_does: "Gathers a full picture of a page deterministically: DOM summary, framework, storage key names, scripts/styles, resource timing, interactive controls, headings, and readable text. Given a url, it OPENS that url as a visible page first (this is how you open a search result link), then understands it; otherwise it understands the current/open tab.",
    when_to_use: "When the user asks what a page is, how it works, what it does, its structure, components, controls, or content. Also use with a url to OPEN and read a specific result link returned by search_web.",
    when_not_to_use: "Do not use for live API/XHR/network traffic (use capture_network), to RUN a web search (use search_web first), or for local files (use read_workspace).",
    produces: "A page summary: title/url, framework, DOM/forms/controls counts, storage key names, resource-timing types, headings, and a text sample. The page's actionable element map is also painted/captured automatically for the next planning round.",
    args: [
      { name: "tabId", type: "number", required: false, description: "Target tab id. Omit for the active tab." },
      { name: "url", type: "string", required: false, description: "A URL to open as a visible page first, then understand — e.g. a result link from search_web. Omit to understand the current tab." }
    ]
  },
  {
    tool: "capture_network",
    obvious_name: "Capture the page's network traffic",
    what_it_does: "Records the live requests the current page makes — XHR, fetch, WebSocket, GraphQL — by reloading with capture attached, then summarizes endpoints, origins, and auth signals.",
    when_to_use: "When the user wants to know what API calls/requests/endpoints a page makes, how it talks to its backend, its API design, data model, or auth pattern (runtime behavior).",
    when_not_to_use: "Do not use for static page structure (use understand_page) — this reloads the page and shows a debugging banner, so only use it for genuine network/API questions.",
    produces: "A network summary: endpoint table, GraphQL operations, origins, WebSocket connections, and detected credential signals (values not included).",
    args: [
      { name: "tabId", type: "number", required: false, description: "Target tab id. Omit for the active tab." }
    ]
  },
  {
    tool: "inspect_runtime",
    obvious_name: "Inspect the page's console (errors & warnings)",
    what_it_does: "Reads the current page's runtime console output — console.log/info/warn/error/debug calls plus uncaught JavaScript errors and unhandled promise rejections — using a document_start shim that also captures messages logged during page load, then summarizes errors and warnings (deduped, most-recent-first).",
    when_to_use: "When the user asks why a page is broken, what errors it logs, what's in the console, whether there are JavaScript errors/warnings/exceptions, or to debug a runtime failure on the CURRENT page.",
    when_not_to_use: "Do not use for DOM/page structure, components, or content (use understand_page). Do not use for network/API traffic, requests, or endpoints (use capture_network). This tool is ONLY for console messages and uncaught exceptions.",
    produces: "A console summary: a totals header (errors/warnings, unique counts, suppressed info/debug), uncaught page errors, console.error calls, and console.warn calls — deduped with repeat counts, most-recent first.",
    args: [
      { name: "tabId", type: "number", required: false, description: "Target tab id. Omit for the active tab." },
      { name: "levels", type: "string[]", required: false, description: "Console levels to include. Defaults to [\"error\",\"warn\"]. Add \"info\", \"debug\", or \"log\" to surface those too." },
      { name: "includeStacks", type: "string", required: false, description: "\"true\" to include reduced stack traces; default shows only the top frame." }
    ]
  },
  {
    tool: "search_web",
    obvious_name: "Search the web",
    what_it_does: "Runs a web search in the BACKGROUND (the results page is not shown to the user) and returns a ranked-enough list of candidate result links. It does NOT open the result pages — to read one, follow up with understand_page using that link's url, which opens it as a visible page. Open as many result links as the task needs (the pipeline stops once the gathered information is sufficient).",
    when_to_use: "When answering needs current/external information not on the open page or in local files — facts, docs, news, products, images.",
    when_not_to_use: "Do not use for questions about the current page (use understand_page) or local files (use read_workspace).",
    produces: "A numbered list of candidate result links (title + url). Open a chosen link with understand_page(url) to read that page.",
    args: [
      { name: "query", type: "string", required: true, description: "The search query." },
      { name: "searchType", type: "string", required: false, description: "\"web\" (default) or \"images\"." }
    ]
  },
  {
    tool: "read_workspace",
    obvious_name: "Read/list/search live workspace files by path",
    what_it_does: "LIVE access to the connected folder: connection status, a recursive directory listing, a content/name search, and full reads of SPECIFIC files by path. Reads the current on-disk content (not the index), so use it when you need an exact, up-to-date file by its path.",
    when_to_use: "When you need the LIVE contents of a specific file/path, an exact directory listing, or to read a file you intend to edit. Pairs with write_workspace for edits.",
    when_not_to_use: "Do not use to WRITE files (use write_workspace), for web/page questions, or as the FIRST way to find information in the attached source — for that, use query_file (it searches the whole indexed corpus and returns ranked passages with locations).",
    produces: "A workspace summary: connection status, file tree, search matches, and the content of any requested files.",
    args: [
      { name: "query", type: "string", required: false, description: "Content/name search to run across the workspace." },
      { name: "readPaths", type: "string[]", required: false, description: "Explicit relative file paths to read in full." },
      { name: "path", type: "string", required: false, description: "Directory to list/search from. Defaults to root." }
    ]
  },
  {
    tool: "query_file",
    obvious_name: "Search the attached source (file or folder)",
    what_it_does: "Searches the user's attached source — either ONE file or the WHOLE connected folder — which has been ingested and indexed into a corpus. Returns the exact passages/rows that best match your query terms, each tagged with its location (for folders: the file path › section · line). Retrieval is deterministic: you supply query terms, the engine returns the ranked applicable units across all indexed files. This is the primary way to find information in the user's source.",
    when_to_use: "ALWAYS use this FIRST when a source is attached and the user's request is about its contents (a document, spreadsheet, paper, or anything in the connected folder/codebase). On a re-plan, set broaden=true and/or vary the query terms to pull more. Note: a folder's index may still be BUILDING — if a query comes up short, a slightly later query can surface more.",
    when_not_to_use: "Do not use when no source is attached. Do not use to read a SPECIFIC known file path verbatim or to prepare an edit (use read_workspace), or for web/page questions.",
    produces: "The matching passages/rows from the attached source, each tagged with its location (file path for folders), plus surrounding context.",
    args: [
      { name: "query", type: "string", required: true, description: "Search terms drawn from the user's request; include synonyms. The user's full prompt is automatically included as well." },
      { name: "broaden", type: "string", required: false, description: "Set \"true\" on a re-query to widen the search and pull more surrounding context when the first query was insufficient." }
    ]
  },
  {
    tool: "act_on_page",
    obvious_name: "Act on the current page",
    what_it_does: "Captures a numbered map of every actionable element on the page (the 'actionable map'), then performs a specific sequence of interactions (click, type, select, press key, scroll), verifying by observing before and after. The map is captured automatically as the first step and reported in the result, with each element's index, role, accessible name, state, and link destination.",
    when_to_use: "When the user asks to interact with the page — click a button, fill a field, choose an option, scroll, submit a form.",
    when_not_to_use: "Do not use to merely read/understand a page (use understand_page). This performs real, possibly irreversible actions, so only include steps the user actually asked for.",
    produces: "The actionable map (index → element, with link destinations) plus a summary of which steps ran, their status, and the page state afterward. If the user asked for a post-action report, include the follow-up page-understanding step in the same plan; the executor will resume it after the page state settles.",
    args: [
      { name: "tabId", type: "number", required: false, description: "Target tab id. Omit for the active tab." },
      { name: "steps", type: "step[]", required: true, description: "Ordered interaction steps. Each: {action: click|type|select|press_key|scroll, target?, text?, value?, optionText?, key?, direction?}. PREFER targeting by overlayIndex (the numbered badge from the actionable map) for precise, unambiguous actions — e.g. target:{overlayIndex: 5}. You may also target by text/role/name/selector when the index is unknown." }
    ]
  },
  {
    tool: "write_workspace",
    obvious_name: "Write a local file",
    what_it_does: "Creates or overwrites a named text file in the connected workspace folder.",
    when_to_use: "When the user asks to create, save, write, or overwrite a local file. Choose a sensible relative path and provide the full content.",
    when_not_to_use: "Do not use to read or search files (use read_workspace).",
    produces: "A confirmation of the file written (or the reason it could not be).",
    args: [
      { name: "path", type: "string", required: true, description: "Relative file path, e.g. notes.md or src/util.ts. If the user gave no name, choose a sensible one." },
      { name: "content", type: "string", required: true, description: "The full file content to write." }
    ]
  }
];

/** Render the cards as plain text for the planner prompt. */
export function renderCardsForPrompt(): string {
  return FAT_TOOL_CARDS.map((card) => {
    const args = card.args.length
      ? card.args.map((a) => `    - ${a.name} (${a.type}${a.required ? ", required" : ""}): ${a.description}`).join("\n")
      : "    (none)";
    return [
      `TOOL: ${card.tool}  — ${card.obvious_name}`,
      `  What it does: ${card.what_it_does}`,
      `  Use when: ${card.when_to_use}`,
      `  Do NOT use when: ${card.when_not_to_use}`,
      `  Produces: ${card.produces}`,
      `  Args:`,
      args
    ].join("\n");
  }).join("\n\n");
}

export function cardForTool(tool: string): FatToolCard | undefined {
  return FAT_TOOL_CARDS.find((card) => card.tool === tool);
}

/**
 * A one-line-per-tool capability brief (no arg schemas). Used by the follow-up
 * step so any suggested next step is grounded in what the assistant can ACTUALLY
 * do, rather than a vague "let me know if…".
 */
export function renderCapabilitiesBrief(): string {
  return FAT_TOOL_CARDS.map((card) => `- ${card.obvious_name}: ${card.what_it_does}`).join("\n");
}
