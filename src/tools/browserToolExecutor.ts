import type {
  EvidenceBrowserState,
  EvidenceItem,
  OpenedSourceEvidence,
  SearchCandidate,
  ToolFailureEvidence
} from "../evidence/evidenceTypes";
import type {
  BrowserExecutionEventType,
  BrowserExecutionStatus,
  ExecutionLogEntry,
  ToolExecutionResult,
  UniversalStepResult,
  VisibleBrowserAction,
  VisibleBrowserActionKind
} from "../execution/executionTypes";
import type { BrowserToolName } from "./browserToolList";

export type BrowserToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type BrowserToolExecution = {
  callId: string;
  toolName: string;
  status: "success" | "partial" | "failed";
  output?: unknown;
  error?: string;
  warnings: string[];
  summary: string;
  activity: ExecutionLogEntry;
  stepResult: UniversalStepResult;
  toolResult: ToolExecutionResult;
  evidenceItems: EvidenceItem[];
  failures: ToolFailureEvidence[];
  searchCandidates: SearchCandidate[];
  openedSources: OpenedSourceEvidence[];
  extractedSections: string[];
  extractedTextSample: string;
  prunedTabIds: number[];
  groupedTabIds: number[];
  focusedTab?: {
    tabId?: number;
    url?: string;
    title?: string;
  };
  browserState?: EvidenceBrowserState;
  visibleActions: VisibleBrowserAction[];
};

type ToolRuntimeResult = {
  status?: BrowserToolExecution["status"];
  output: unknown;
  summary: string;
  warnings?: string[];
  kind: VisibleBrowserActionKind;
  eventType: BrowserExecutionEventType;
  visible: boolean;
  evidenceItems?: EvidenceItem[];
  searchCandidates?: SearchCandidate[];
  openedSources?: OpenedSourceEvidence[];
  extractedSections?: string[];
  extractedTextSample?: string;
  prunedTabIds?: number[];
  groupedTabIds?: number[];
  focusedTab?: BrowserToolExecution["focusedTab"];
  browserState?: EvidenceBrowserState;
};

export type PageLink = {
  text: string;
  url: string;
};

export type PageSnapshot = {
  url: string;
  title: string;
  description?: string;
  headings: string[];
  text: string;
  links: PageLink[];
};

type SerializedTab = {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
  status?: string;
};

export async function executeBrowserTool(call: BrowserToolCall): Promise<BrowserToolExecution> {
  const startedAt = new Date().toISOString();
  const input = asRecord(call.input);

  try {
    const runtime = await runBrowserTool(call.name as BrowserToolName, input);
    const endedAt = new Date().toISOString();
    return buildExecution({
      call,
      input,
      startedAt,
      endedAt,
      runtime
    });
  } catch (error) {
    const endedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "Unknown browser tool failure.";
    const failure = makeFailureEvidence(call.name, message, startedAt);
    return buildExecution({
      call,
      input,
      startedAt,
      endedAt,
      runtime: {
        status: "failed",
        output: { error: message },
        summary: message,
        warnings: [message],
        kind: "source_lookup",
        eventType: "failure",
        visible: false,
        evidenceItems: [failure],
        searchCandidates: [],
        openedSources: [],
        failures: [failure]
      } as ToolRuntimeResult & { failures: ToolFailureEvidence[] },
      failures: [failure],
      error: message
    });
  }
}

async function runBrowserTool(name: BrowserToolName, input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  switch (name) {
    case "browser_read_active_tab":
      return readActiveTab(input);
    case "browser_list_tabs":
      return listTabs(input);
    case "browser_open_tab":
      return openTab(input);
    case "browser_navigate_active_tab":
      return navigateActiveTab(input);
    case "web_search":
      return webSearch(input);
    case "browser_extract_page":
      return extractPage(input);
    case "browser_find_in_page":
      return findInPage(input);
    case "browser_history_search":
      return searchHistory(input);
    case "browser_group_tabs":
      return groupTabs(input);
    case "browser_close_tabs":
      return closeTabs(input);
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}

async function readActiveTab(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getActiveTab();
  const includeSnapshot = asBoolean(input.includeSnapshot, false);
  const maxChars = clampNumber(input.maxChars, 4000, 500, 20000);
  const includeLinks = asBoolean(input.includeLinks, false);
  const serialized = serializeTab(tab);

  if (!includeSnapshot) {
    return {
      output: { tab: serialized },
      summary: serialized.title || serialized.url || "Read active tab.",
      kind: "active_tab",
      eventType: "tab_read",
      visible: false,
      browserState: {
        activeTab: {
          tabId: serialized.id,
          title: serialized.title,
          url: serialized.url
        },
        openedTabs: []
      },
      evidenceItems: [
        makeValueEvidence("Active tab", serialized, serialized.title || serialized.url || "Active tab metadata")
      ]
    };
  }

  const snapshot = await snapshotTab(requiredTabId(tab), { maxChars, includeLinks });
  return {
    output: { tab: serialized, snapshot },
    summary: snapshot.title || snapshot.url || "Read active page snapshot.",
    kind: "snapshot",
    eventType: "tab_read",
    visible: false,
    browserState: {
      activeTab: {
        tabId: serialized.id,
        title: serialized.title,
        url: serialized.url
      },
      currentPage: {
        title: snapshot.title,
        url: snapshot.url
      },
      openedTabs: []
    },
    evidenceItems: [makePageEvidence(snapshot, "Active page snapshot", serialized.id)],
    extractedSections: snapshot.headings,
    extractedTextSample: snapshot.text
  };
}

async function listTabs(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const currentWindowOnly = asBoolean(input.currentWindowOnly, true);
  const tabs = await chrome.tabs.query(currentWindowOnly ? { currentWindow: true } : {});
  const serialized = tabs.map(serializeTab);
  return {
    output: { tabs: serialized },
    summary: `${serialized.length} tab(s).`,
    kind: "active_tab",
    eventType: "tab_read",
    visible: false,
    browserState: {
      activeTab: serialized.find((tab) => tab.active),
      openedTabs: serialized.map((tab) => ({
        tabId: tab.id,
        title: tab.title,
        url: tab.url
      }))
    },
    evidenceItems: [makeValueEvidence("Tabs", serialized, `${serialized.length} open tab(s)`)]
  };
}

async function openTab(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const url = normalizeHttpUrl(requiredString(input.url, "url"));
  const active = asBoolean(input.active, true);
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id !== undefined) {
    await waitForTabComplete(tab.id, 12_000).catch(() => undefined);
  }
  const refreshed = tab.id !== undefined ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
  const serialized = serializeTab(refreshed);
  return {
    output: { tab: serialized },
    summary: serialized.title || serialized.url || "Opened tab.",
    kind: "open_tab",
    eventType: "tab_navigate",
    visible: true,
    openedSources: [
      {
        tabId: serialized.id,
        title: serialized.title,
        url: serialized.url
      }
    ],
    focusedTab: {
      tabId: serialized.id,
      title: serialized.title,
      url: serialized.url
    },
    browserState: {
      openedTabs: [
        {
          tabId: serialized.id,
          title: serialized.title,
          url: serialized.url
        }
      ]
    } as EvidenceBrowserState,
    evidenceItems: [
      makeSourceEvidence({
        summary: serialized.title || serialized.url || "Opened source tab",
        title: serialized.title,
        url: serialized.url,
        tabId: serialized.id
      })
    ]
  };
}

async function navigateActiveTab(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const action = requiredString(input.action, "action");
  const tab = await getActiveTab();
  const tabId = requiredTabId(tab);

  if (action === "go_to") {
    const url = normalizeHttpUrl(requiredString(input.url, "url"));
    await chrome.tabs.update(tabId, { url, active: true });
    await waitForTabComplete(tabId, 12_000).catch(() => undefined);
  } else if (action === "reload") {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, 12_000).catch(() => undefined);
  } else if (action === "back") {
    await callTabHistoryNavigation("goBack", tabId);
  } else if (action === "forward") {
    await callTabHistoryNavigation("goForward", tabId);
  } else {
    throw new Error(`Unsupported navigation action: ${action}`);
  }

  const refreshed = serializeTab(await chrome.tabs.get(tabId));
  return {
    output: { action, tab: refreshed },
    summary: `${action}: ${refreshed.title || refreshed.url || "active tab"}`,
    kind: action === "reload" ? "reload" : "navigate",
    eventType: action === "reload" ? "reload" : "tab_navigate",
    visible: true,
    focusedTab: {
      tabId: refreshed.id,
      title: refreshed.title,
      url: refreshed.url
    },
    browserState: {
      activeTab: {
        tabId: refreshed.id,
        title: refreshed.title,
        url: refreshed.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence("Navigation", { action, tab: refreshed }, `${action}: ${refreshed.title || refreshed.url}`)
    ]
  };
}

async function webSearch(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const query = requiredString(input.query, "query");
  const includeSnapshot = asBoolean(input.includeSnapshot, true);
  const maxChars = clampNumber(input.maxChars, 6000, 500, 30000);
  const tabsBefore = await chrome.tabs.query({ currentWindow: true });
  const tabIdsBefore = new Set(tabsBefore.map((tab) => tab.id).filter((tabId): tabId is number => tabId !== undefined));

  await chrome.search.query({
    text: query,
    disposition: "NEW_TAB"
  });

  const tab = await findSearchResultTab(tabIdsBefore);
  const serialized = serializeTab(tab);
  let snapshot: PageSnapshot | undefined;
  const warnings: string[] = [];

  if (includeSnapshot && serialized.id !== undefined) {
    try {
      await waitForTabComplete(serialized.id, 12_000).catch(() => undefined);
      snapshot = await snapshotTab(serialized.id, { maxChars, includeLinks: true });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not snapshot the search results page.");
    }
  }

  return {
    status: warnings.length && !snapshot ? "partial" : "success",
    output: {
      query,
      provider: "chrome_default_search",
      tab: serialized,
      snapshot
    },
    summary: serialized.title || serialized.url || `Searched for "${query}".`,
    warnings,
    kind: "web_search",
    eventType: "tool",
    visible: true,
    openedSources: [
      {
        tabId: serialized.id,
        title: serialized.title,
        url: serialized.url
      }
    ],
    focusedTab: {
      tabId: serialized.id,
      title: serialized.title,
      url: serialized.url
    },
    browserState: {
      activeTab: {
        tabId: serialized.id,
        title: serialized.title,
        url: serialized.url
      },
      currentPage: snapshot
        ? {
            title: snapshot.title,
            url: snapshot.url
          }
        : undefined,
      openedTabs: [
        {
          tabId: serialized.id,
          title: serialized.title,
          url: serialized.url
        }
      ]
    },
    evidenceItems: snapshot
      ? [makePageEvidence(snapshot, `Search results for "${query}"`, serialized.id)]
      : [
          makeSourceEvidence({
            summary: `Visible search results for "${query}"`,
            title: serialized.title,
            url: serialized.url,
            tabId: serialized.id,
            sourceType: "search_results_page"
          })
        ],
    extractedSections: snapshot?.headings ?? [],
    extractedTextSample: snapshot?.text ?? ""
  };
}

async function extractPage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = input.tabId === undefined ? await getActiveTab() : await chrome.tabs.get(requiredNumber(input.tabId, "tabId"));
  const tabId = requiredTabId(tab);
  const maxChars = clampNumber(input.maxChars, 8000, 500, 50000);
  const includeLinks = asBoolean(input.includeLinks, true);
  const snapshot = await snapshotTab(tabId, { maxChars, includeLinks });
  return {
    output: {
      tab: serializeTab(tab),
      page: snapshot
    },
    summary: snapshot.title || snapshot.url || "Extracted page.",
    kind: "extract",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: snapshot.title,
        url: snapshot.url
      },
      openedTabs: []
    },
    evidenceItems: [makePageEvidence(snapshot, "Extracted page", tabId)],
    extractedSections: snapshot.headings,
    extractedTextSample: snapshot.text
  };
}

async function findInPage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const query = requiredString(input.query, "query");
  const tab = input.tabId === undefined ? await getActiveTab() : await chrome.tabs.get(requiredNumber(input.tabId, "tabId"));
  const tabId = requiredTabId(tab);
  const maxMatches = clampNumber(input.maxMatches, 6, 1, 20);
  const snapshot = await snapshotTab(tabId, { maxChars: 50000, includeLinks: false });
  const matches = findTextMatches(snapshot.text, query, maxMatches);
  const warnings = matches.length ? [] : [`No passages matched "${query}".`];
  return {
    status: matches.length ? "success" : "partial",
    output: {
      tab: serializeTab(tab),
      url: snapshot.url,
      title: snapshot.title,
      query,
      matches
    },
    summary: `${matches.length} passage(s) matched "${query}".`,
    warnings,
    kind: "scroll_scan",
    eventType: "tool",
    visible: false,
    evidenceItems: [
      makePageEvidence(
        {
          ...snapshot,
          text: matches.join("\n\n")
        },
        `Page matches for "${query}"`,
        tabId
      )
    ],
    extractedSections: matches,
    extractedTextSample: matches.join("\n\n")
  };
}

async function searchHistory(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const text = asString(input.text, "");
  const maxResults = clampNumber(input.maxResults, 8, 1, 25);
  const daysBack = clampNumber(input.daysBack, 14, 1, 365);
  const startTime = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const entries = await chrome.history.search({ text, maxResults, startTime });
  const compact = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    url: entry.url,
    lastVisitTime: entry.lastVisitTime
  }));
  return {
    output: { query: text, entries: compact },
    summary: `${compact.length} history entr${compact.length === 1 ? "y" : "ies"}.`,
    kind: "history",
    eventType: "history_action",
    visible: false,
    evidenceItems: [makeValueEvidence("History", compact, `${compact.length} matching history entries`)]
  };
}

async function groupTabs(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tabIds = requiredNumberArray(input.tabIds, "tabIds");
  const title = requiredString(input.title, "title").slice(0, 40);
  const color = asString(input.color, "blue") as chrome.tabGroups.ColorEnum;
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title, color }).catch(() => undefined);
  return {
    output: { groupId, tabIds, title, color },
    summary: `Grouped ${tabIds.length} tab(s) as "${title}".`,
    kind: "group_tabs",
    eventType: "tool",
    visible: true,
    groupedTabIds: tabIds,
    evidenceItems: [makeValueEvidence("Tab group", { groupId, tabIds, title, color }, `Grouped tabs: ${title}`)]
  };
}

async function closeTabs(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tabIds = requiredNumberArray(input.tabIds, "tabIds");
  await chrome.tabs.remove(tabIds);
  return {
    output: { closedTabIds: tabIds },
    summary: `Closed ${tabIds.length} tab(s).`,
    kind: "prune_tabs",
    eventType: "tool",
    visible: true,
    prunedTabIds: tabIds,
    evidenceItems: [makeValueEvidence("Closed tabs", tabIds, `Closed ${tabIds.length} tab(s)`)]
  };
}

function buildExecution(args: {
  call: BrowserToolCall;
  input: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  runtime: ToolRuntimeResult;
  failures?: ToolFailureEvidence[];
  error?: string;
}): BrowserToolExecution {
  const status = args.runtime.status ?? "success";
  const browserStatus: BrowserExecutionStatus =
    status === "failed" ? "failed" : status === "partial" ? "partial" : "completed";
  const warnings = args.runtime.warnings ?? [];
  const visibleAction: VisibleBrowserAction = {
    id: makeId("action"),
    kind: args.runtime.kind,
    eventType: args.runtime.eventType,
    label: args.call.name,
    status: browserStatus,
    visible: args.runtime.visible,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    resultSummary: args.runtime.summary,
    warning: warnings[0],
    metadata: {
      input: args.input
    }
  };
  const toolResult: ToolExecutionResult = {
    callId: args.call.id,
    toolName: args.call.name,
    status,
    output: args.runtime.output,
    error: args.error,
    warnings,
    visibleActions: [visibleAction],
    startedAt: args.startedAt,
    endedAt: args.endedAt
  };
  const stepResult: UniversalStepResult = {
    stepId: args.call.id,
    capability: args.call.name,
    status: browserStatus === "completed" ? "completed" : browserStatus,
    startedAt: args.startedAt,
    completedAt: args.endedAt,
    input: args.input,
    output: args.runtime.output,
    warnings,
    errors: args.error ? [args.error] : [],
    visibleActionPerformed: args.runtime.visible,
    evidenceProduced: Boolean(args.runtime.evidenceItems?.length),
    summary: args.runtime.summary,
    toolName: args.call.name,
    toolResult
  };

  return {
    callId: args.call.id,
    toolName: args.call.name,
    status,
    output: args.runtime.output,
    error: args.error,
    warnings,
    summary: args.runtime.summary,
    activity: {
      id: makeId("log"),
      timestamp: args.endedAt,
      level: status === "failed" ? "error" : status === "partial" ? "warning" : "info",
      label: args.call.name,
      details: args.runtime.summary,
      toolName: args.call.name,
      actionLabel: args.call.name,
      status: browserStatus,
      eventType: args.runtime.eventType,
      resultSummary: args.runtime.summary,
      warning: warnings[0]
    },
    stepResult,
    toolResult,
    evidenceItems: args.runtime.evidenceItems ?? [],
    failures: args.failures ?? [],
    searchCandidates: args.runtime.searchCandidates ?? [],
    openedSources: args.runtime.openedSources ?? [],
    extractedSections: args.runtime.extractedSections ?? [],
    extractedTextSample: args.runtime.extractedTextSample ?? "",
    prunedTabIds: args.runtime.prunedTabIds ?? [],
    groupedTabIds: args.runtime.groupedTabIds ?? [],
    focusedTab: args.runtime.focusedTab,
    browserState: args.runtime.browserState,
    visibleActions: [visibleAction]
  };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    throw new Error("No active tab is available.");
  }

  return tab;
}

async function findSearchResultTab(tabIdsBefore: Set<number>): Promise<chrome.tabs.Tab> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(250);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const newActiveTab = tabs.find((tab) => tab.active && tab.id !== undefined && !tabIdsBefore.has(tab.id));
    if (newActiveTab) {
      return newActiveTab;
    }

    const newTab = tabs.find((tab) => tab.id !== undefined && !tabIdsBefore.has(tab.id));
    if (newTab) {
      return newTab;
    }
  }

  return getActiveTab();
}

function requiredTabId(tab: chrome.tabs.Tab): number {
  if (tab.id === undefined) {
    throw new Error("Tab id is unavailable.");
  }

  return tab.id;
}

export async function snapshotTab(
  tabId: number,
  options: { maxChars: number; includeLinks: boolean }
): Promise<PageSnapshot> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageSnapshot,
    args: [options]
  });

  if (!result?.result) {
    throw new Error("Page snapshot returned no content.");
  }

  return result.result;
}

function collectPageSnapshot(options: { maxChars: number; includeLinks: boolean }): PageSnapshot {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const description =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ||
    undefined;
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 60);
  const text = (document.body?.innerText ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
  const links = options.includeLinks
    ? Array.from(document.links)
        .map((link) => ({
          text: (link.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
          url: link.href
        }))
        .filter((link) => link.url && /^https?:\/\//i.test(link.url))
        .slice(0, 120)
    : [];

  return {
    url: location.href,
    title: document.title,
    description,
    headings,
    text,
    links
  };
}

function serializeTab(tab: chrome.tabs.Tab): SerializedTab {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    status: tab.status
  };
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const current = await chrome.tabs.get(tabId).catch(() => undefined);
  if (current?.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = globalThis.setTimeout(cleanup, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeoutId);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function callTabHistoryNavigation(method: "goBack" | "goForward", tabId: number): Promise<void> {
  const tabsApi = chrome.tabs as typeof chrome.tabs & {
    goBack?: (tabId?: number) => Promise<void>;
    goForward?: (tabId?: number) => Promise<void>;
  };
  const fn = tabsApi[method];
  if (!fn) {
    throw new Error(`Chrome tabs.${method} is unavailable.`);
  }

  await fn(tabId);
}

function findTextMatches(text: string, query: string, maxMatches: number): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const terms = normalizedQuery.split(/\s+/).filter((term) => term.length > 2);
  const matches = paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    return lower.includes(normalizedQuery) || terms.some((term) => lower.includes(term));
  });

  return matches.slice(0, maxMatches).map((match) => match.slice(0, 900));
}

function makePageEvidence(snapshot: PageSnapshot, summary: string, tabId?: number): EvidenceItem {
  return {
    id: makeId("evidence"),
    createdAt: new Date().toISOString(),
    type: "page",
    evidenceClass: "executed_tool",
    quality: snapshot.text ? "strong" : "thin",
    summary,
    warnings: snapshot.text ? [] : ["No readable body text was extracted."],
    url: snapshot.url,
    title: snapshot.title,
    headings: snapshot.headings,
    textSample: snapshot.text,
    provenance: {
      tabId,
      url: snapshot.url,
      title: snapshot.title,
      collectedAt: new Date().toISOString()
    }
  };
}

function makeSourceEvidence(args: {
  summary: string;
  title?: string;
  url?: string;
  tabId?: number;
  sourceType?: string;
}): EvidenceItem {
  return {
    id: makeId("evidence"),
    createdAt: new Date().toISOString(),
    type: "source",
    evidenceClass: "executed_tool",
    quality: args.url ? "partial" : "thin",
    summary: args.summary,
    warnings: [],
    title: args.title,
    url: args.url,
    sourceType: args.sourceType,
    provenance: {
      tabId: args.tabId,
      title: args.title,
      url: args.url,
      collectedAt: new Date().toISOString()
    }
  };
}

function makeValueEvidence(label: string, value: unknown, summary: string): EvidenceItem {
  return {
    id: makeId("evidence"),
    createdAt: new Date().toISOString(),
    type: "value",
    evidenceClass: "executed_tool",
    quality: "partial",
    summary,
    warnings: [],
    label,
    value,
    provenance: {
      collectedAt: new Date().toISOString()
    }
  };
}

function makeFailureEvidence(toolName: string, error: string, createdAt: string): ToolFailureEvidence {
  return {
    id: makeId("failure"),
    createdAt,
    type: "tool_failure",
    evidenceClass: "failed_capability",
    quality: "failed",
    summary: error,
    warnings: [error],
    toolName,
    error,
    provenance: {
      toolName,
      collectedAt: createdAt
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string field: ${field}.`);
  }

  return value.trim();
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Missing required number field: ${field}.`);
  }

  return value;
}

function requiredNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`Missing required number array field: ${field}.`);
  }

  const numbers = value.filter((item): item is number => typeof item === "number" && !Number.isNaN(item));
  if (!numbers.length) {
    throw new Error(`Missing required number array field: ${field}.`);
  }

  return numbers;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeHttpUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported.");
  }

  return parsed.href;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
