import type {
  EvidenceBrowserState,
  EvidenceItem,
  OpenedSourceEvidence,
  SearchCandidate,
  ToolFailureEvidence
} from "../evidence/evidenceTypes";
import { makeFailureEvidence } from "../evidence/evidenceBuilders";
import type {
  BrowserExecutionEventType,
  BrowserExecutionStatus,
  ExecutionLogEntry,
  ToolExecutionResult,
  UniversalStepResult,
  VisibleBrowserAction,
  VisibleBrowserActionKind
} from "../execution/executionTypes";
import { delay } from "../shared/asyncUtils";
import { makeId } from "../shared/id";
import { normalizeHttpUrl } from "../shared/urlUtils";
import {
  getWorkspaceStatus,
  listWorkspaceDirectory,
  readWorkspaceImageFile,
  readWorkspaceFile,
  searchWorkspace,
  writeWorkspaceFile
} from "../filesystem/workspaceStore";
import { getActiveCorpus } from "../filecorpus/corpusStore";
import { formatRankedUnitsForModel, lexicalRanker } from "../filecorpus/rankUnits";
import { waitForTabComplete } from "./chromeTabs";
import type { BrowserToolName } from "./browserToolList";
import {
  checkPageCondition,
  hasPageActionTarget,
  hasPageCondition,
  normalizePageActionTarget,
  normalizePageCondition,
  observeTab,
  performPageAction,
  type PageActionOptions,
  type PageActionTarget,
  type PageCondition,
  type PageConditionCheck,
  type PageInteractionAction,
  type PageInteractionResult,
  type PageObservation
} from "./pageInteraction";
import { snapshotFromFetchedText, snapshotTab, type PageSnapshot } from "./pageSnapshot";
import { detectSearchResultBlocker } from "./searchBlocker";
import {
  runCaptureNetwork,
  type CaptureAction,
  type CaptureToolInput
} from "./networkCapture/browserCaptureNetwork";
import {
  collectImageSearchResultsInPage,
  collectPageAppInspectionInPage,
  runSafePageExplorationInPage
} from "./browser/injectedPageScripts";

export { snapshotTab } from "./pageSnapshot";
export type {
  PageActionTarget,
  PageCondition,
  PageConditionCheck,
  PageInteractionResult,
  PageObservation
} from "./pageInteraction";
export type {
  PageCodeBlock,
  PageForm,
  PageLink,
  PageMetadata,
  PagePriceCandidate,
  PageSnapshot,
  PageTable
} from "./pageSnapshot";

export type BrowserToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type BrowserToolExecutionOptions = {
  allowPageActions?: boolean;
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

export type BrowserToolDelegate = (call: BrowserToolCall) => Promise<BrowserToolExecution | undefined>;

type ToolRuntimeResult = {
  status?: BrowserToolExecution["status"];
  output: unknown;
  error?: string;
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
  failures?: ToolFailureEvidence[];
};

type SerializedTab = {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
  active?: boolean;
  status?: string;
};

export type ImageSearchResult = {
  index: number;
  title: string;
  source?: string;
  pageUrl?: string;
  thumbnailUrl?: string;
};

export type ImageSearchPageResult = {
  url: string;
  title: string;
  imageCount: number;
  images: ImageSearchResult[];
};

type TabGroupPlan = {
  title: string;
  color?: chrome.tabGroups.Color;
  tabIds: number[];
};

type SnapshotToolOptions = {
  maxChars: number;
  includeLinks: boolean;
  includeStructured?: boolean;
  targetedTerms?: string[];
  fullTextMaxChars?: number;
};

type SnapshotToolResult = {
  snapshot: PageSnapshot;
  warnings: string[];
  status: BrowserToolExecution["status"];
};

export type PageAppInspectionOptions = {
  includeDomTree: boolean;
  includeNetwork: boolean;
  includeStorage: boolean;
  includeStorageValues: boolean;
  includeScripts: boolean;
  includeStyles: boolean;
  maxDomNodes: number;
  maxTreeDepth: number;
  maxResources: number;
  maxTextChars: number;
};

export type PageAppDomNode = {
  tagName: string;
  id?: string;
  classes?: string[];
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
  visible: boolean;
  childElementCount: number;
  children?: PageAppDomNode[];
};

export type PageAppInspection = {
  url: string;
  title: string;
  readyState: string;
  language?: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  scroll: {
    x: number;
    y: number;
    maxY: number;
  };
  location: {
    origin: string;
    pathname: string;
    search: string;
    hash: string;
  };
  document: {
    doctype?: string;
    charset?: string;
    referrer?: string;
    visibilityState?: string;
    activeElement?: string;
  };
  frameworkHints: string[];
  domSummary: {
    totalElements: number;
    byTag: Record<string, number>;
    headings: Array<{ level: number; text: string; id?: string }>;
    landmarks: Array<{ tagName: string; role?: string; id?: string; name?: string; text?: string }>;
    forms: Array<{
      index: number;
      id?: string;
      name?: string;
      action?: string;
      method?: string;
      fieldCount: number;
      submitTexts: string[];
      fields: Array<{
        tagName: string;
        type?: string;
        name?: string;
        id?: string;
        label?: string;
        placeholder?: string;
        required: boolean;
        disabled: boolean;
      }>;
    }>;
    interactiveElements: Array<{
      tagName: string;
      role?: string;
      type?: string;
      id?: string;
      name?: string;
      text?: string;
      label?: string;
      href?: string;
      disabled: boolean;
      visible: boolean;
    }>;
  };
  domTree?: PageAppDomNode;
  network?: {
    navigation?: Record<string, unknown>;
    resourceCountsByType: Record<string, number>;
    resourceOrigins: Array<{ origin: string; count: number }>;
    resources: Array<{
      url: string;
      origin?: string;
      path?: string;
      initiatorType?: string;
      startTimeMs?: number;
      durationMs?: number;
      transferSize?: number;
      encodedBodySize?: number;
      decodedBodySize?: number;
    }>;
    apiLikeResources: Array<{
      url: string;
      initiatorType?: string;
      startTimeMs?: number;
      durationMs?: number;
    }>;
  };
  scripts?: {
    external: Array<{ src: string; type?: string; async: boolean; defer: boolean }>;
    inlineCount: number;
    moduleCount: number;
  };
  styles?: {
    external: Array<{ href: string; media?: string }>;
    inlineCount: number;
  };
  storage?: {
    localStorage?: Array<{ key: string; valueLength?: number; valueSample?: string }>;
    sessionStorage?: Array<{ key: string; valueLength?: number; valueSample?: string }>;
    cookies?: {
      count: number;
      names: string[];
      valuesIncluded: false;
    };
    indexedDB?: Array<{ name?: string; version?: number }>;
    warnings: string[];
  };
  warnings: string[];
};

export type PageExplorationMiniSnapshot = {
  url: string;
  title: string;
  scrollY: number;
  maxY: number;
  visibleText: string;
  headings: string[];
  controls: Array<{
    tagName: string;
    role?: string;
    type?: string;
    name?: string;
    text?: string;
    href?: string;
  }>;
  resourceCount: number;
  storageKeys: {
    localStorage: string[];
    sessionStorage: string[];
  };
};

export type PageExplorationTarget = {
  tagName: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  href?: string;
  selectorHint?: string;
};

export type PageExplorationEvent = {
  kind: "snapshot" | "scroll" | "safe_interaction" | "skipped_risky" | "warning";
  label: string;
  detail?: string;
  target?: PageExplorationTarget;
  before?: PageExplorationMiniSnapshot;
  after?: PageExplorationMiniSnapshot;
  diff?: PageExplorationDiff;
  warning?: string;
};

export type PageExplorationDiff = {
  urlChanged: boolean;
  newHeadings: string[];
  newControls: string[];
  newResourceCount: number;
  newStorageKeys: {
    localStorage: string[];
    sessionStorage: string[];
  };
  visibleTextChanged: boolean;
};

export type PageExplorationScriptResult = {
  url: string;
  title: string;
  events: PageExplorationEvent[];
  skippedRiskyTargets: PageExplorationTarget[];
  warnings: string[];
};

type PageExplorationResult = {
  tab: SerializedTab;
  beforeInspection: PageAppInspection;
  beforeObservation?: PageObservation;
  interactionTimeline: PageExplorationScriptResult;
  afterObservation?: PageObservation;
  afterInspection: PageAppInspection;
  warnings: string[];
};

const TOOL_SNAPSHOT_TIMEOUT_MS = 8_000;
const TOOL_SNAPSHOT_POLL_MS = 350;
const MIN_USEFUL_TOOL_SNAPSHOT_CHARS = 80;
const BACKGROUND_SNAPSHOT_TIMEOUT_MS = 8_000;
let workspaceToolDelegate: BrowserToolDelegate | undefined;

export function setWorkspaceToolDelegate(delegate: BrowserToolDelegate | undefined): void {
  workspaceToolDelegate = delegate;
}

export async function executeBrowserTool(call: BrowserToolCall, options: BrowserToolExecutionOptions = {}): Promise<BrowserToolExecution> {
  if (workspaceToolDelegate && isDelegatedToolName(call.name)) {
    const delegated = await workspaceToolDelegate(call);
    if (delegated) {
      return delegated;
    }
  }

  return executeBrowserToolLocally(call, options);
}

export async function executeBrowserToolLocally(call: BrowserToolCall, options: BrowserToolExecutionOptions = {}): Promise<BrowserToolExecution> {
  const startedAt = new Date().toISOString();
  const input = asRecord(call.input);

  try {
    if (options.allowPageActions === false && isPageMutatingToolName(call.name)) {
      throw new Error("Page actions are disabled in Settings. Enable Allow page actions before using click, type, select, or keypress tools.");
    }
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

function isWorkspaceToolName(name: string): boolean {
  return name === "fs_get_workspace" ||
    name === "fs_list_directory" ||
    name === "fs_read_file" ||
    name === "fs_open_image" ||
    name === "fs_search_files" ||
    name === "fs_write_file";
}

/**
 * Tools that must run in the side panel (their data — the workspace handle and
 * the file corpus — lives in panel IndexedDB, not the service worker). These
 * are routed to the panel via the delegate.
 */
function isDelegatedToolName(name: string): boolean {
  return isWorkspaceToolName(name) || name === "corpus_query";
}

function isPageMutatingToolName(name: string): boolean {
  return name === "browser_click" ||
    name === "browser_type" ||
    name === "browser_select" ||
    name === "browser_press_key";
}

async function runBrowserTool(name: BrowserToolName, input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  // corpus_query is a panel-only delegated tool (its data lives in panel
  // IndexedDB); it is not part of the model's BrowserToolName tool list, so it
  // is handled before the typed switch.
  if ((name as string) === "corpus_query") {
    return queryCorpus(input);
  }
  switch (name) {
    case "browser_read_active_tab":
      return readActiveTab(input);
    case "browser_list_tabs":
      return listTabs(input);
    case "browser_open_tab":
      return openTab(input);
    case "browser_group_tabs":
      return groupTabs(input);
    case "browser_navigate_active_tab":
      return navigateActiveTab(input);
    case "browser_observe_page":
      return observePage(input);
    case "browser_inspect_page_app":
      return inspectPageApp(input);
    case "browser_explore_page":
      return explorePage(input);
    case "browser_click":
      return interactWithPage("click", input);
    case "browser_type":
      return interactWithPage("type", input);
    case "browser_select":
      return interactWithPage("select", input);
    case "browser_press_key":
      return interactWithPage("press", input);
    case "browser_scroll_page":
      return interactWithPage("scroll", input);
    case "browser_wait_for":
      return waitForPage(input);
    case "browser_assert_page":
      return assertPage(input);
    case "web_search":
      return webSearch(input);
    case "browser_extract_page":
      return extractPage(input);
    case "browser_find_in_page":
      return findInPage(input);
    case "browser_capture_network":
      return runCaptureNetworkTool(input);
    case "fs_get_workspace":
      return getWorkspace();
    case "fs_list_directory":
      return listDirectory(input);
    case "fs_read_file":
      return readFile(input);
    case "fs_open_image":
      return openWorkspaceImage(input);
    case "fs_search_files":
      return searchFiles(input);
    case "fs_write_file":
      return writeFile(input);
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}

async function readActiveTab(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getActiveTab();
  const includeSnapshot = asBoolean(input.includeSnapshot, false);
  const maxChars = clampNumber(input.maxChars, 4000, 500, Number.MAX_SAFE_INTEGER);
  const includeLinks = asBoolean(input.includeLinks, false);
  const includeStructured = asBoolean(input.includeStructured, true);
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

  const snapshotResult = await snapshotTabForTool(tab, { maxChars, includeLinks, includeStructured });
  const snapshot = snapshotResult.snapshot;
  return {
    status: snapshotResult.status,
    output: { tab: serialized, snapshot },
    summary: snapshot.title || snapshot.url || "Read active page snapshot.",
    warnings: snapshotResult.warnings,
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

async function groupTabs(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tabGroupsApi = chrome.tabGroups;
  if (!tabGroupsApi?.update) {
    throw new Error("Chrome tabGroups API is unavailable. Check that the extension has the tabGroups permission.");
  }

  const currentWindowOnly = asBoolean(input.currentWindowOnly, true);
  const groupPlans = normalizeTabGroupPlans(input.groups);
  const tabs = await chrome.tabs.query(currentWindowOnly ? { currentWindow: true } : {});
  const tabsById = new Map(tabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => [tab.id as number, tab]));
  const groupedTabIds = new Set<number>();
  const groups = [];

  for (const plan of groupPlans) {
    const plannedTabs = plan.tabIds.map((tabId) => {
      const tab = tabsById.get(tabId);
      if (!tab) {
        throw new Error(`Tab ${tabId} is not available${currentWindowOnly ? " in the current window" : ""}. Run browser_list_tabs before grouping tabs.`);
      }
      if (groupedTabIds.has(tabId)) {
        throw new Error(`Tab ${tabId} appears in more than one requested group.`);
      }
      return tab;
    });
    const windowIds = new Set(plannedTabs.map((tab) => tab.windowId).filter((windowId): windowId is number => windowId !== undefined));
    if (windowIds.size > 1) {
      throw new Error(`Tabs in group "${plan.title}" must be in the same Chrome window.`);
    }

    const groupId = await chrome.tabs.group({
      tabIds: tabIdsForChrome(plan.tabIds)
    });
    const updatedGroup = await tabGroupsApi.update(groupId, {
      title: plan.title,
      color: plan.color
    });

    for (const tabId of plan.tabIds) {
      groupedTabIds.add(tabId);
    }

    groups.push({
      groupId,
      title: updatedGroup?.title ?? plan.title,
      color: updatedGroup?.color ?? plan.color,
      tabIds: plan.tabIds,
      tabs: plannedTabs.map(serializeTab)
    });
  }

  const groupedTabs = tabs.filter((tab) => tab.id !== undefined && groupedTabIds.has(tab.id));
  return {
    output: { groups },
    summary: `${groups.length} tab group${groups.length === 1 ? "" : "s"} created for ${groupedTabIds.size} tab${groupedTabIds.size === 1 ? "" : "s"}.`,
    kind: "group_tabs",
    eventType: "tool",
    visible: true,
    groupedTabIds: [...groupedTabIds],
    browserState: {
      openedTabs: groupedTabs.map((tab) => ({
        tabId: tab.id,
        title: tab.title,
        url: tab.url
      }))
    },
    evidenceItems: [
      makeValueEvidence("Tab groups", groups, `${groups.length} Chrome tab group${groups.length === 1 ? "" : "s"} created`)
    ]
  };
}

async function navigateActiveTab(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const action = requiredString(input.action, "action");
  // Target an explicit tab when given (so a single task can navigate its own
  // research tab); otherwise the active tab. go_to activates the tab regardless.
  const explicitTabId = typeof input.tabId === "number" ? input.tabId : undefined;
  const tab = explicitTabId !== undefined ? await chrome.tabs.get(explicitTabId) : await getActiveTab();
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

async function observePage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const maxElements = clampNumber(input.maxElements, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const includeInvisible = asBoolean(input.includeInvisible, false);
  const observation = await observeTab(tabId, { maxElements, includeInvisible });
  const serialized = serializeTab(tab);
  return {
    output: { tab: serialized, observation },
    summary: `Observed ${observation.elements.length} interactive element(s) on ${observation.title || observation.url}.`,
    warnings: observation.warnings,
    kind: "observe",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: observation.title,
        url: observation.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        "Page observation",
        compactObservationForEvidence(observation),
        `Observed ${observation.elements.length} page element(s)`
      )
    ],
    extractedSections: observation.elements
      .map((element) => [element.role, element.name || element.label || element.text || element.selector].filter(Boolean).join(": ")),
    extractedTextSample: observation.textSample
  };
}

async function inspectPageApp(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const options: PageAppInspectionOptions = {
    includeDomTree: asBoolean(input.includeDomTree, true),
    includeNetwork: asBoolean(input.includeNetwork, true),
    includeStorage: asBoolean(input.includeStorage, true),
    includeStorageValues: asBoolean(input.includeStorageValues, false),
    includeScripts: asBoolean(input.includeScripts, true),
    includeStyles: asBoolean(input.includeStyles, true),
    maxDomNodes: clampNumber(input.maxDomNodes, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    maxTreeDepth: clampNumber(input.maxTreeDepth, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    maxResources: clampNumber(input.maxResources, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    maxTextChars: clampNumber(input.maxTextChars, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)
  };
  const inspection = await extractPageAppInspection(tabId, options);
  const serialized = serializeTab(tab);
  const resourceCount = inspection.network?.resources.length ?? 0;
  const interactiveCount = inspection.domSummary.interactiveElements.length;
  const summary = [
    `Inspected ${inspection.domSummary.totalElements} DOM element(s)`,
    `${interactiveCount} interactive/control element(s)`,
    `${resourceCount} resource timing entr${resourceCount === 1 ? "y" : "ies"}`
  ].join(", ");

  return {
    status: inspection.warnings.length ? "partial" : "success",
    output: {
      tab: serialized,
      inspection
    },
    summary,
    warnings: inspection.warnings,
    kind: "observe",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: inspection.title,
        url: inspection.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        "Page app inspection",
        compactPageAppInspectionForEvidence(inspection),
        summary
      )
    ],
    extractedSections: pageAppInspectionSections(inspection),
    extractedTextSample: summarizePageAppInspectionText(inspection)
  };
}

async function explorePage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const serialized = serializeTab(tab);
  const inspectionOptions: PageAppInspectionOptions = {
    includeDomTree: true,
    includeNetwork: true,
    includeStorage: true,
    includeStorageValues: asBoolean(input.includeStorageValues, false),
    includeScripts: true,
    includeStyles: true,
    maxDomNodes: Number.MAX_SAFE_INTEGER,
    maxTreeDepth: Number.MAX_SAFE_INTEGER,
    maxResources: Number.MAX_SAFE_INTEGER,
    maxTextChars: Number.MAX_SAFE_INTEGER
  };

  const beforeInspection = await extractPageAppInspection(tabId, inspectionOptions);
  const beforeObservation = await observeTab(tabId, {
    maxElements: Number.MAX_SAFE_INTEGER,
    includeInvisible: false
  }).catch(() => undefined);
  const interactionTimeline = await runSafePageExploration(tabId);
  const afterObservation = await observeTab(tabId, {
    maxElements: Number.MAX_SAFE_INTEGER,
    includeInvisible: false
  }).catch(() => undefined);
  const afterInspection = await extractPageAppInspection(tabId, inspectionOptions);
  const warnings = [
    ...beforeInspection.warnings,
    ...interactionTimeline.warnings,
    ...afterInspection.warnings
  ];
  const safeInteractionCount = interactionTimeline.events.filter((event) => event.kind === "safe_interaction").length;
  const scrollCount = interactionTimeline.events.filter((event) => event.kind === "scroll").length;
  const resourceDelta = (afterInspection.network?.resources.length ?? 0) - (beforeInspection.network?.resources.length ?? 0);
  const result: PageExplorationResult = {
    tab: serialized,
    beforeInspection,
    beforeObservation,
    interactionTimeline,
    afterObservation,
    afterInspection,
    warnings
  };
  const summary = [
    `Explored page with ${beforeInspection.domSummary.totalElements} initial DOM element(s)`,
    `${beforeObservation?.elements.length ?? beforeInspection.domSummary.interactiveElements.length} initial interactive/control element(s)`,
    `${scrollCount} scroll step(s)`,
    `${safeInteractionCount} safe interaction(s)`,
    `${interactionTimeline.skippedRiskyTargets.length} risky target(s) skipped`,
    `${resourceDelta >= 0 ? "+" : ""}${resourceDelta} resource timing entr${Math.abs(resourceDelta) === 1 ? "y" : "ies"} after exploration`
  ].join(", ");

  return {
    status: warnings.length ? "partial" : "success",
    output: {
      exploration: result
    },
    summary,
    warnings,
    kind: "observe",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: afterInspection.title || beforeInspection.title,
        url: afterInspection.url || beforeInspection.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        "Page exploration pipeline",
        result,
        summary
      )
    ],
    extractedSections: pageExplorationSections(result),
    extractedTextSample: summarizePageExplorationText(result)
  };
}

async function interactWithPage(
  action: PageInteractionAction,
  input: Record<string, unknown>
): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const target = normalizePageActionTarget(input);
  const targetRequired = action === "click" || action === "type" || action === "select";
  if (targetRequired && !hasPageActionTarget(target)) {
    throw new Error(`${toolNameForPageAction(action)} requires a target from browser_observe_page or a selector/text/role target.`);
  }

  const options = pageActionOptionsFromInput(action, input);
  const result = await performPageAction(tabId, action, target, options);
  const waitMs = clampNumber(input.waitMs, action === "click" ? 500 : 250, 0, Number.MAX_SAFE_INTEGER);
  if (waitMs > 0) {
    await delay(waitMs);
  }
  await waitForTabComplete(tabId, 5000).catch(() => undefined);

  const includeObservation = asBoolean(input.includeObservation, true);
  const observation = includeObservation
    ? await observeTab(tabId, { maxElements: Number.MAX_SAFE_INTEGER }).catch(() => undefined)
    : undefined;
  const warnings = [
    ...result.warnings,
    ...(observation?.warnings ?? [])
  ];
  const title = observation?.title || result.title;
  const url = observation?.url || result.url;
  return {
    status: warnings.length ? "partial" : "success",
    output: {
      action: result,
      observation
    },
    summary: `${actionLabel(action)}: ${result.target?.name || result.target?.label || result.target?.text || result.target?.selector || "page"}.`,
    warnings,
    kind: actionKind(action),
    eventType: "tool",
    visible: true,
    focusedTab: {
      tabId,
      title,
      url
    },
    browserState: {
      activeTab: {
        tabId,
        title,
        url
      },
      currentPage: {
        title,
        url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        `Page ${actionLabel(action).toLowerCase()}`,
        {
          action: result,
          observation: observation ? compactObservationForEvidence(observation) : undefined
        },
        `${actionLabel(action)} completed${result.target ? ` on ${result.target.name || result.target.selector}` : ""}`
      )
    ],
    extractedSections: observation?.elements
      .map((element) => [element.role, element.name || element.label || element.text || element.selector].filter(Boolean).join(": ")) ?? [],
    extractedTextSample: observation?.textSample ?? ""
  };
}

async function waitForPage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const condition = normalizePageCondition(input);
  if (!hasPageCondition(condition)) {
    throw new Error("browser_wait_for requires at least one condition: selector, text, urlIncludes, or titleIncludes.");
  }

  const timeoutMs = clampNumber(input.timeoutMs, 5000, 100, Number.MAX_SAFE_INTEGER);
  const started = Date.now();
  let check = await checkPageCondition(tabId, condition);
  while (!check.satisfied && Date.now() - started < timeoutMs) {
    await delay(250);
    check = await checkPageCondition(tabId, condition);
  }

  const elapsedMs = Date.now() - started;
  const status = check.satisfied ? "success" : "partial";
  const warnings = check.satisfied ? [] : [`Condition was not satisfied within ${timeoutMs}ms.`];
  return {
    status,
    output: {
      check,
      elapsedMs
    },
    summary: check.satisfied
      ? `Wait condition satisfied after ${elapsedMs}ms.`
      : `Wait condition was not satisfied after ${elapsedMs}ms.`,
    warnings,
    kind: "wait",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: check.title,
        url: check.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        "Page wait",
        { check, elapsedMs },
        check.satisfied ? "Page wait condition satisfied" : "Page wait condition not satisfied"
      )
    ],
    extractedSections: [formatPageCondition(condition)],
    extractedTextSample: check.textSample
  };
}

async function assertPage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = await getTabFromInput(input);
  const tabId = requiredTabId(tab);
  const condition = normalizePageCondition(input);
  if (!hasPageCondition(condition)) {
    throw new Error("browser_assert_page requires at least one condition: selector, text, urlIncludes, or titleIncludes.");
  }

  const check = await checkPageCondition(tabId, condition);
  if (!check.satisfied) {
    throw new Error(`Page assertion failed: ${formatPageCondition(condition)}.`);
  }

  return {
    output: { check },
    summary: `Page assertion passed: ${formatPageCondition(condition)}.`,
    kind: "assert",
    eventType: "tool",
    visible: false,
    browserState: {
      currentPage: {
        title: check.title,
        url: check.url
      },
      openedTabs: []
    },
    evidenceItems: [
      makeValueEvidence(
        "Page assertion",
        check,
        `Page assertion passed: ${formatPageCondition(condition)}`
      )
    ],
    extractedSections: [formatPageCondition(condition)],
    extractedTextSample: check.textSample
  };
}

async function webSearch(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const query = requiredString(input.query, "query");
  const searchType = input.searchType === "images" ? "images" : "web";
  if (searchType === "images") {
    return imageSearch(input, query);
  }

  const includeSnapshot = asBoolean(input.includeSnapshot, true);
  const background = asBoolean(input.background, false);
  const maxChars = clampNumber(input.maxChars, 6000, 500, Number.MAX_SAFE_INTEGER);
  const reuseTabId = input.tabId === undefined ? undefined : requiredNumber(input.tabId, "tabId");
  const tabsBefore = await chrome.tabs.query({ currentWindow: true });
  const tabIdsBefore = new Set(tabsBefore.map((tab) => tab.id).filter((tabId): tabId is number => tabId !== undefined));

  // Tab selection, in priority order:
  //  - reuseTabId given → navigate THAT tab to the SERP (no new tab). This is how
  //    the research path keeps the whole pipeline in the user's current tab.
  //  - background → open Google in an inactive tab (legacy background search).
  //  - else → foreground via the user's default engine in a new tab.
  let tab: chrome.tabs.Tab;
  if (reuseTabId !== undefined) {
    await chrome.tabs.update(reuseTabId, { url: makeGoogleWebSearchUrl(query) });
    await waitForTabComplete(reuseTabId, 12_000).catch(() => undefined);
    tab = await chrome.tabs.get(reuseTabId);
  } else if (background) {
    const created = await chrome.tabs.create({ url: makeGoogleWebSearchUrl(query), active: false });
    tab = created.id !== undefined ? await chrome.tabs.get(created.id).catch(() => created) : created;
  } else {
    await chrome.search.query({ text: query, disposition: "NEW_TAB" });
    tab = await findSearchResultTab(tabIdsBefore);
  }
  const serialized = serializeTab(tab);
  let snapshot: PageSnapshot | undefined;
  const warnings: string[] = [];

  if (includeSnapshot && serialized.id !== undefined) {
    try {
      await waitForTabComplete(serialized.id, 12_000).catch(() => undefined);
      const snapshotResult = await snapshotTabForTool(tab, { maxChars, includeLinks: true, includeStructured: false });
      snapshot = snapshotResult.snapshot;
      warnings.push(...snapshotResult.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not snapshot the search results page.");
    }
  }

  const blockerWarning = snapshot
    ? detectSearchResultBlocker({
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text
      })
    : detectSearchResultBlocker({
        url: serialized.url,
        title: serialized.title
      });
  if (blockerWarning) {
    const failure = makeFailureEvidence("web_search", blockerWarning);
    return {
      status: "failed",
      output: {
        query,
        provider: "chrome_default_search",
        tab: serialized,
        blockedReason: blockerWarning
      },
      error: blockerWarning,
      summary: blockerWarning,
      warnings: [...warnings, blockerWarning],
      kind: "web_search",
      eventType: "failure",
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
        openedTabs: [
          {
            tabId: serialized.id,
            title: serialized.title,
            url: serialized.url
          }
        ]
      },
      evidenceItems: [failure],
      failures: [failure],
      extractedSections: [],
      extractedTextSample: ""
    };
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

async function imageSearch(input: Record<string, unknown>, query: string): Promise<ToolRuntimeResult> {
  const includeSnapshot = asBoolean(input.includeSnapshot, false);
  const maxChars = clampNumber(input.maxChars, 6000, 500, Number.MAX_SAFE_INTEGER);
  const minImages = clampNumber(input.minImages, 24, 1, Number.MAX_SAFE_INTEGER);
  const url = makeGoogleImagesSearchUrl(query);
  const tab = await chrome.tabs.create({ url, active: true });
  const serialized = serializeTab(tab);
  const tabId = requiredTabId(tab);
  const warnings: string[] = [];
  let imageResults: ImageSearchPageResult | undefined;
  let snapshot: PageSnapshot | undefined;

  await waitForTabComplete(tabId, 12_000).catch(() => undefined);

  try {
    imageResults = await extractImageSearchResults(tabId, minImages);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Could not extract image search results.");
  }

  if (includeSnapshot) {
    try {
      const snapshotResult = await snapshotTabForTool(tab, { maxChars, includeLinks: true, includeStructured: false });
      snapshot = snapshotResult.snapshot;
      warnings.push(...snapshotResult.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Could not snapshot the image search results page.");
    }
  }

  const count = imageResults?.imageCount ?? 0;
  return {
    status: count > 0 ? "success" : "partial",
    output: {
      query,
      searchType: "images",
      provider: "google_images",
      tab: serialized,
      minImages,
      imageResults,
      snapshot
    },
    summary: count > 0
      ? `Opened Google Images for "${query}" and found ${count} visible image result(s).`
      : `Opened Google Images for "${query}".`,
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
      currentPage: {
        title: imageResults?.title ?? snapshot?.title ?? serialized.title,
        url: imageResults?.url ?? snapshot?.url ?? serialized.url
      },
      openedTabs: [
        {
          tabId: serialized.id,
          title: serialized.title,
          url: serialized.url
        }
      ]
    },
    evidenceItems: [
      makeValueEvidence(
        "Image search results",
        {
          query,
          provider: "google_images",
          resultCount: count,
          images: imageResults?.images ?? []
        },
        `Image search results for "${query}"`
      )
    ],
    extractedSections: imageResults?.images.map((image) => image.title).filter(Boolean) ?? [],
    extractedTextSample: imageResults?.images.map((image) => {
      const source = image.source ? ` (${image.source})` : "";
      return `${image.index}. ${image.title}${source}`;
    }).join("\n") ?? ""
  };
}

async function extractPage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const tab = input.tabId === undefined ? await getActiveTab() : await chrome.tabs.get(requiredNumber(input.tabId, "tabId"));
  const tabId = requiredTabId(tab);
  const maxChars = clampNumber(input.maxChars, 8000, 500, Number.MAX_SAFE_INTEGER);
  const includeLinks = asBoolean(input.includeLinks, true);
  const includeStructured = asBoolean(input.includeStructured, true);
  const snapshotResult = await snapshotTabForTool(tab, { maxChars, includeLinks, includeStructured });
  const snapshot = snapshotResult.snapshot;
  return {
    status: snapshotResult.status,
    output: {
      tab: serializeTab(tab),
      page: snapshot
    },
    summary: snapshot.title || snapshot.url || "Extracted page.",
    warnings: snapshotResult.warnings,
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
  const maxMatches = clampNumber(input.maxMatches, 6, 1, Number.MAX_SAFE_INTEGER);
  const snapshotResult = await snapshotTabForTool(tab, { maxChars: 50000, includeLinks: false, includeStructured: false });
  const snapshot = snapshotResult.snapshot;
  const matches = findTextMatches(snapshot.text, query, maxMatches);
  const warnings = [
    ...snapshotResult.warnings,
    ...(matches.length ? [] : [`No passages matched "${query}".`])
  ];
  return {
    status: matches.length && snapshotResult.status === "success" ? "success" : "partial",
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

async function runCaptureNetworkTool(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const action = requiredString(input.action, "action") as CaptureAction;
  if (!["start", "stop", "summary", "dump"].includes(action)) {
    throw new Error(`Unsupported capture action: ${action}.`);
  }

  const tabId = input.tabId === undefined
    ? requiredTabId(await getActiveTab())
    : requiredNumber(input.tabId, "tabId");

  const captureInput: CaptureToolInput = {
    action,
    tabId,
    urlIncludes: typeof input.urlIncludes === "string" ? input.urlIncludes : undefined,
    methods: Array.isArray(input.methods)
      ? input.methods.filter((method): method is string => typeof method === "string")
      : undefined,
    onlySensitive: asBoolean(input.onlySensitive, false),
    includeBodies: asBoolean(input.includeBodies, true),
    maxRequests: optionalNumber(input.maxRequests)
  };

  const result = await runCaptureNetwork(captureInput);
  const failed = action === "start" && !result.capturing && result.source === "none";

  return {
    status: failed ? "failed" : result.warnings.length ? "partial" : "success",
    output: result,
    error: failed ? result.message : undefined,
    summary: result.message,
    warnings: result.warnings,
    kind: "observe",
    eventType: failed ? "failure" : "tool",
    visible: action === "start" || action === "stop",
    evidenceItems: [
      makeValueEvidence(
        `Network capture (${action})`,
        result.summary ?? { message: result.message, requestCount: result.requests?.length ?? 0 },
        result.message
      )
    ],
    failures: failed ? [makeFailureEvidence("browser_capture_network", result.message)] : undefined
  };
}

async function queryCorpus(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const corpus = await getActiveCorpus();
  if (!corpus) {
    return {
      status: "partial",
      output: { active: false },
      summary: "No working file is attached.",
      warnings: ["No working file is attached."],
      kind: "filesystem",
      eventType: "tool",
      visible: false,
      evidenceItems: []
    };
  }

  const query = asString(input.query, "");
  const broaden = asBoolean(input.broaden, false);
  const ranked = await lexicalRanker.rank(corpus, query, {
    limit: broaden ? 16 : 8,
    neighborRadius: broaden ? 2 : 1
  });
  const matchCount = ranked.filter((item) => !item.pulledAsNeighbor).length;
  const rendered = formatRankedUnitsForModel(ranked);
  const isFolder = corpus.sourceType === "folder";
  const sourceLabel = isFolder
    ? `folder "${corpus.fileName}" (${corpus.fileCount ?? 0} files)`
    : `file ${corpus.fileName}`;
  const buildingNote = corpus.building
    ? " The folder index is still building, so a later query may surface more."
    : "";

  return {
    status: "success",
    output: {
      active: true,
      fileName: corpus.fileName,
      sourceType: corpus.sourceType,
      building: corpus.building === true,
      matchCount,
      rendered
    },
    summary: `Working ${sourceLabel}: ${matchCount} matching unit(s).${buildingNote}`,
    warnings: [],
    kind: "filesystem",
    eventType: "tool",
    visible: false,
    evidenceItems: [makeValueEvidence("Working file", { fileName: corpus.fileName, matchCount }, `Queried ${corpus.fileName}`)]
  };
}

async function getWorkspace(): Promise<ToolRuntimeResult> {
  const status = await getWorkspaceStatus();
  return {
    output: { workspace: status },
    summary: status.connected
      ? `Workspace: ${status.rootName ?? "connected folder"} (read ${status.readPermission}, write ${status.writePermission}).`
      : "No workspace folder is connected.",
    warnings: status.connected ? [] : ["Connect a workspace folder in Settings before using filesystem tools."],
    kind: "filesystem",
    eventType: "tool",
    visible: false,
    evidenceItems: [makeValueEvidence("Workspace", status, status.connected ? "Connected workspace" : "No connected workspace")]
  };
}

async function listDirectory(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const result = await listWorkspaceDirectory({
    path: asString(input.path, ""),
    recursive: asBoolean(input.recursive, false),
    maxEntries: optionalNumber(input.maxEntries)
  });
  const warnings = result.truncated ? [`Directory listing was capped at ${result.entries.length} entries.`] : [];
  return {
    status: result.truncated ? "partial" : "success",
    output: result,
    summary: `${result.entries.length} workspace entr${result.entries.length === 1 ? "y" : "ies"} listed.`,
    warnings: [...warnings, ...result.warnings],
    kind: "filesystem",
    eventType: "tool",
    visible: false,
    evidenceItems: [makeValueEvidence("Workspace directory", result, `Listed ${result.entries.length} workspace entries`)]
  };
}

async function readFile(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const path = requiredString(input.path, "path");
  const result = await readWorkspaceFile({
    path,
    maxChars: optionalNumber(input.maxChars),
    maxBytes: optionalNumber(input.maxBytes),
    lineRange: readLineRange(input.lineRange)
  });
  const warnings = [
    ...result.warnings,
    ...(result.truncated ? [`${result.path} was truncated.`] : [])
  ];
  return {
    status: result.truncated ? "partial" : "success",
    output: result,
    summary: `Read ${result.path}.`,
    warnings,
    kind: "filesystem",
    eventType: "tool",
    visible: false,
    evidenceItems: [makeValueEvidence("Workspace file", result, `Read ${result.path}`)],
    extractedSections: [result.path],
    extractedTextSample: result.text
  };
}

async function openWorkspaceImage(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const path = requiredString(input.path, "path");
  const active = asBoolean(input.active, true);
  const image = await readWorkspaceImageFile({ path });
  const viewerPath = `src/image-viewer/index.html?path=${encodeURIComponent(image.path)}`;
  const url = chrome.runtime.getURL(viewerPath);
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id !== undefined) {
    await waitForTabComplete(tab.id, 12_000).catch(() => undefined);
  }
  const refreshed = tab.id !== undefined ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
  const serialized = serializeTab(refreshed);
  const output = {
    path: image.path,
    name: image.name,
    size: image.size,
    lastModified: image.lastModified,
    type: image.type,
    viewerUrl: url,
    tab: serialized
  };

  return {
    output,
    summary: `Opened ${image.path} in the image viewer.`,
    kind: "open_tab",
    eventType: "tab_navigate",
    visible: true,
    openedSources: [
      {
        tabId: serialized.id,
        title: serialized.title || image.name,
        url: serialized.url
      }
    ],
    focusedTab: {
      tabId: serialized.id,
      title: serialized.title || image.name,
      url: serialized.url
    },
    browserState: {
      openedTabs: [
        {
          tabId: serialized.id,
          title: serialized.title || image.name,
          url: serialized.url
        }
      ]
    } as EvidenceBrowserState,
    evidenceItems: [
      makeSourceEvidence({
        summary: `Opened workspace image ${image.path}`,
        title: image.name,
        url: serialized.url,
        tabId: serialized.id
      })
    ]
  };
}

async function searchFiles(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const query = requiredString(input.query, "query");
  const result = await searchWorkspace({
    query,
    path: asString(input.path, ""),
    includeContent: asBoolean(input.includeContent, true),
    maxResults: optionalNumber(input.maxResults),
    maxBytes: optionalNumber(input.maxBytes)
  });
  const warnings = [
    ...result.warnings,
    ...(result.truncated ? [`Workspace search was capped at ${result.matches.length} matches.`] : [])
  ];
  return {
    status: warnings.length ? "partial" : "success",
    output: result,
    summary: `${result.matches.length} workspace match${result.matches.length === 1 ? "" : "es"} for "${query}".`,
    warnings,
    kind: "filesystem",
    eventType: "tool",
    visible: false,
    evidenceItems: [makeValueEvidence("Workspace search", result, `${result.matches.length} workspace search matches`)],
    extractedSections: result.matches.map((match) =>
      match.line ? `${match.path}:${match.line}` : match.path
    ),
    extractedTextSample: result.matches
      .map((match) => [match.line ? `${match.path}:${match.line}` : match.path, match.preview].filter(Boolean).join(" "))
      .join("\n")
  };
}

async function writeFile(input: Record<string, unknown>): Promise<ToolRuntimeResult> {
  const path = requiredString(input.path, "path");
  const content = requiredText(input.content, "content");
  let result;
  try {
    result = await writeWorkspaceFile({
      path,
      content,
      createParents: asBoolean(input.createParents, true)
    });
  } catch (error) {
    const status = await getWorkspaceStatus().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Workspace write failed.";
    const statusText = status
      ? ` Workspace status: connected=${status.connected}, read=${status.readPermission}, write=${status.writePermission}.`
      : "";
    throw new Error(`${message}${statusText}`);
  }
  return {
    output: result,
    summary: `Wrote ${result.path}.`,
    kind: "filesystem",
    eventType: "tool",
    visible: true,
    evidenceItems: [makeValueEvidence("Workspace write", result, `Wrote ${result.path}`)]
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
  const error = args.error ?? args.runtime.error;
  const durationMs = durationBetween(args.startedAt, args.endedAt);
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
    durationMs,
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
    error,
    warnings,
    visibleActions: [visibleAction],
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMs
  };
  const stepResult: UniversalStepResult = {
    stepId: args.call.id,
    capability: args.call.name,
    status: browserStatus === "completed" ? "completed" : browserStatus,
    startedAt: args.startedAt,
    completedAt: args.endedAt,
    durationMs,
    input: args.input,
    output: args.runtime.output,
    warnings,
    errors: error ? [error] : [],
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
    error,
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
      warning: warnings[0],
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      durationMs
    },
    stepResult,
    toolResult,
    evidenceItems: args.runtime.evidenceItems ?? [],
    failures: args.failures ?? args.runtime.failures ?? [],
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

function durationBetween(startedAt: string, endedAt: string): number {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    return 0;
  }

  return Math.max(0, ended - started);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    throw new Error("No active tab is available.");
  }

  return tab;
}

async function getTabFromInput(input: Record<string, unknown>): Promise<chrome.tabs.Tab> {
  return input.tabId === undefined
    ? getActiveTab()
    : chrome.tabs.get(requiredNumber(input.tabId, "tabId"));
}

function pageActionOptionsFromInput(
  action: PageInteractionAction,
  input: Record<string, unknown>
): PageActionOptions {
  const options: PageActionOptions = {};
  if (action === "type") {
    options.text = requiredText(input.text, "text");
    options.clear = asBoolean(input.clear, true);
  }
  if (action === "select") {
    const value = asString(input.value, "");
    const optionText = asString(input.optionText, "");
    if (!value && !optionText) {
      throw new Error("browser_select requires either value or optionText.");
    }
    options.value = value || undefined;
    options.optionText = optionText || undefined;
  }
  if (action === "press") {
    options.key = requiredString(input.key, "key");
  }
  if (action === "scroll") {
    const direction = asString(input.direction, "down");
    if (
      direction === "up" ||
      direction === "down" ||
      direction === "left" ||
      direction === "right" ||
      direction === "top" ||
      direction === "bottom"
    ) {
      options.direction = direction;
    } else {
      throw new Error(`Unsupported scroll direction: ${direction}.`);
    }
    options.amount = optionalNumber(input.amount);
  }
  return options;
}

function toolNameForPageAction(action: PageInteractionAction): string {
  switch (action) {
    case "click":
      return "browser_click";
    case "type":
      return "browser_type";
    case "select":
      return "browser_select";
    case "press":
      return "browser_press_key";
    case "scroll":
      return "browser_scroll_page";
  }
}

function actionKind(action: PageInteractionAction): VisibleBrowserActionKind {
  switch (action) {
    case "click":
      return "click";
    case "type":
      return "type";
    case "select":
      return "select";
    case "press":
      return "press_key";
    case "scroll":
      return "scroll_scan";
  }
}

function actionLabel(action: PageInteractionAction): string {
  switch (action) {
    case "click":
      return "Click";
    case "type":
      return "Type";
    case "select":
      return "Select";
    case "press":
      return "Press key";
    case "scroll":
      return "Scroll";
  }
}

function formatPageCondition(condition: PageCondition): string {
  const parts = [
    condition.selector ? `selector ${condition.selector}${condition.elementState ? ` is ${condition.elementState}` : ""}` : undefined,
    condition.text ? `text includes "${condition.text}"` : undefined,
    condition.urlIncludes ? `URL includes "${condition.urlIncludes}"` : undefined,
    condition.titleIncludes ? `title includes "${condition.titleIncludes}"` : undefined
  ].filter((part): part is string => Boolean(part));

  return parts.join(", ");
}

function compactObservationForEvidence(observation: PageObservation): unknown {
  return {
    url: observation.url,
    title: observation.title,
    readyState: observation.readyState,
    viewport: observation.viewport,
    scroll: observation.scroll,
    textSample: observation.textSample,
    elements: observation.elements.map((element) => ({
      ref: element.ref,
      selector: element.selector,
      role: element.role,
      name: element.name,
      label: element.label,
      text: element.text,
      tagName: element.tagName,
      type: element.type,
      href: element.href,
      disabled: element.disabled,
      editable: element.editable,
      visible: element.visible,
      required: element.required
    })),
    warnings: observation.warnings
  };
}

function compactPageAppInspectionForEvidence(inspection: PageAppInspection): unknown {
  return {
    url: inspection.url,
    title: inspection.title,
    readyState: inspection.readyState,
    frameworkHints: inspection.frameworkHints,
    location: inspection.location,
    domSummary: {
      totalElements: inspection.domSummary.totalElements,
      byTag: inspection.domSummary.byTag,
      headings: inspection.domSummary.headings,
      landmarks: inspection.domSummary.landmarks,
      forms: inspection.domSummary.forms,
      interactiveElements: inspection.domSummary.interactiveElements
    },
    domTree: inspection.domTree,
    network: inspection.network
      ? {
          navigation: inspection.network.navigation,
          resourceCountsByType: inspection.network.resourceCountsByType,
          resourceOrigins: inspection.network.resourceOrigins,
          resources: inspection.network.resources,
          apiLikeResources: inspection.network.apiLikeResources
        }
      : undefined,
    scripts: inspection.scripts
      ? {
          ...inspection.scripts,
          external: inspection.scripts.external
        }
      : undefined,
    styles: inspection.styles
      ? {
          ...inspection.styles,
          external: inspection.styles.external
        }
      : undefined,
    storage: inspection.storage,
    warnings: inspection.warnings
  };
}

function pageAppInspectionSections(inspection: PageAppInspection): string[] {
  return [
    ...inspection.frameworkHints.map((hint) => `Framework/build: ${hint}`),
    ...inspection.domSummary.headings.map((heading) => `H${heading.level}: ${heading.text}`),
    ...inspection.domSummary.forms.map((form) => `Form ${form.index}: ${form.fieldCount} field(s), submits: ${form.submitTexts.join(", ")}`),
    ...inspection.domSummary.interactiveElements.map((element) =>
      [element.role || element.tagName, element.name || element.label || element.text || element.href].filter(Boolean).join(": ")
    ),
    ...(inspection.network?.apiLikeResources.map((resource) => `Network/API: ${resource.initiatorType || "resource"} ${resource.url}`) ?? [])
  ].filter(Boolean);
}

function summarizePageAppInspectionText(inspection: PageAppInspection): string {
  const lines = [
    `URL: ${inspection.url}`,
    `Title: ${inspection.title}`,
    `Ready state: ${inspection.readyState}`,
    inspection.frameworkHints.length ? `Framework/build hints: ${inspection.frameworkHints.join(", ")}` : "Framework/build hints: none detected",
    `DOM elements: ${inspection.domSummary.totalElements}`,
    `Top tags: ${Object.entries(inspection.domSummary.byTag).map(([tag, count]) => `${tag}=${count}`).join(", ")}`,
    inspection.domSummary.headings.length
      ? `Headings:\n${inspection.domSummary.headings.map((heading) => `- H${heading.level} ${heading.text}`).join("\n")}`
      : "Headings: none detected",
    inspection.domSummary.forms.length
      ? `Forms:\n${inspection.domSummary.forms.map((form) => `- ${form.method || "GET"} ${form.action || "(no action)"} fields=${form.fieldCount} submits=${form.submitTexts.join(", ") || "(none)"}`).join("\n")}`
      : "Forms: none detected",
    inspection.domSummary.interactiveElements.length
      ? `Interactive controls:\n${inspection.domSummary.interactiveElements.map((element) =>
          `- ${element.role || element.tagName}${element.type ? `/${element.type}` : ""}: ${element.name || element.label || element.text || element.href || "(unnamed)"}`
        ).join("\n")}`
      : "Interactive controls: none detected",
    inspection.network
      ? [
          `Resource timing entries: ${inspection.network.resources.length}`,
          `Resource types: ${Object.entries(inspection.network.resourceCountsByType).map(([type, count]) => `${type}=${count}`).join(", ") || "none"}`,
          inspection.network.apiLikeResources.length
            ? `API-like resources:\n${inspection.network.apiLikeResources.map((resource) => `- ${resource.initiatorType || "resource"} ${resource.url}`).join("\n")}`
            : "API-like resources: none detected"
        ].join("\n")
      : "Network/resource timing: not requested",
    inspection.storage
      ? [
          `localStorage keys: ${(inspection.storage.localStorage ?? []).map((item) => item.key).join(", ") || "none"}`,
          `sessionStorage keys: ${(inspection.storage.sessionStorage ?? []).map((item) => item.key).join(", ") || "none"}`,
          `cookie names visible to JS: ${inspection.storage.cookies?.names.join(", ") || "none"}`
        ].join("\n")
      : "Storage: not requested"
  ];

  return lines.join("\n");
}

function pageExplorationSections(exploration: PageExplorationResult): string[] {
  return [
    "Pipeline: passive inspection before interaction",
    "Pipeline: interactive observation before interaction",
    ...exploration.interactionTimeline.events.map((event) =>
      [event.kind, event.label, event.detail, event.warning].filter(Boolean).join(": ")
    ),
    "Pipeline: interactive observation after interaction",
    "Pipeline: passive inspection after interaction",
    ...pageAppInspectionSections(exploration.afterInspection)
  ].filter(Boolean);
}

function summarizePageExplorationText(exploration: PageExplorationResult): string {
  const before = exploration.beforeInspection;
  const after = exploration.afterInspection;
  const safeEvents = exploration.interactionTimeline.events.filter((event) => event.kind === "safe_interaction");
  const scrollEvents = exploration.interactionTimeline.events.filter((event) => event.kind === "scroll");
  const skipped = exploration.interactionTimeline.skippedRiskyTargets;
  return [
    "Mandatory page exploration pipeline ran.",
    "",
    "Before interaction:",
    summarizePageAppInspectionText(before),
    "",
    "Interactive observation before interaction:",
    exploration.beforeObservation
      ? `${exploration.beforeObservation.elements.length} interactive element(s) observed.\n${exploration.beforeObservation.elements.map((element) =>
          `- ${element.role || element.tagName}: ${element.name || element.label || element.text || element.selector || "(unnamed)"}`
        ).join("\n")}`
      : "Observation unavailable.",
    "",
    "Interaction timeline:",
    exploration.interactionTimeline.events.map((event) => {
      const target = event.target
        ? [event.target.role || event.target.tagName, event.target.name || event.target.text || event.target.href].filter(Boolean).join(": ")
        : "";
      const diff = event.diff
        ? [
            event.diff.urlChanged ? "URL changed" : undefined,
            event.diff.newHeadings.length ? `new headings=${event.diff.newHeadings.join(" | ")}` : undefined,
            event.diff.newControls.length ? `new controls=${event.diff.newControls.join(" | ")}` : undefined,
            event.diff.newResourceCount ? `new resources=${event.diff.newResourceCount}` : undefined,
            event.diff.newStorageKeys.localStorage.length ? `new localStorage keys=${event.diff.newStorageKeys.localStorage.join(", ")}` : undefined,
            event.diff.newStorageKeys.sessionStorage.length ? `new sessionStorage keys=${event.diff.newStorageKeys.sessionStorage.join(", ")}` : undefined,
            event.diff.visibleTextChanged ? "visible text changed" : undefined
          ].filter(Boolean).join("; ")
        : "";
      return `- ${event.kind}: ${event.label}${target ? ` (${target})` : ""}${event.detail ? ` - ${event.detail}` : ""}${event.warning ? ` - ${event.warning}` : ""}${diff ? ` [${diff}]` : ""}`;
    }).join("\n") || "No timeline events recorded.",
    "",
    `Scroll steps: ${scrollEvents.length}`,
    `Safe interactions performed: ${safeEvents.length}`,
    skipped.length
      ? `Risky targets skipped:\n${skipped.map((target) => `- ${target.role || target.tagName}: ${target.name || target.text || target.href || "(unnamed)"}`).join("\n")}`
      : "Risky targets skipped: none detected",
    "",
    "Interactive observation after interaction:",
    exploration.afterObservation
      ? `${exploration.afterObservation.elements.length} interactive element(s) observed.\n${exploration.afterObservation.elements.map((element) =>
          `- ${element.role || element.tagName}: ${element.name || element.label || element.text || element.selector || "(unnamed)"}`
        ).join("\n")}`
      : "Observation unavailable.",
    "",
    "After interaction:",
    summarizePageAppInspectionText(after)
  ].join("\n");
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

function makeGoogleWebSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    pws: "0",
    filter: "0",
    udm: "14"
  });
  return `https://www.google.com/search?${params.toString()}`;
}

function makeGoogleImagesSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    tbm: "isch",
    udm: "2"
  });
  return `https://www.google.com/search?${params.toString()}`;
}

async function extractImageSearchResults(tabId: number, minImages: number): Promise<ImageSearchPageResult> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectImageSearchResultsInPage,
    args: [minImages]
  });

  if (!result?.result) {
    throw new Error("Image search extraction returned no content.");
  }

  return result.result;
}

export async function extractPageAppInspection(tabId: number, options: PageAppInspectionOptions): Promise<PageAppInspection> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageAppInspectionInPage,
    args: [options]
  });

  if (!result?.result) {
    throw new Error("Page app inspection returned no content.");
  }

  return result.result;
}

async function runSafePageExploration(tabId: number): Promise<PageExplorationScriptResult> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: runSafePageExplorationInPage
  });

  if (!result?.result) {
    throw new Error("Page exploration returned no content.");
  }

  return result.result;
}

async function snapshotTabForTool(
  tab: chrome.tabs.Tab,
  options: SnapshotToolOptions
): Promise<SnapshotToolResult> {
  const tabId = requiredTabId(tab);
  const warnings: string[] = [];
  let lastSnapshot: PageSnapshot | undefined;
  let lastError: unknown;
  let stableCount = 0;
  let lastSignature = "";
  const deadline = Date.now() + TOOL_SNAPSHOT_TIMEOUT_MS;

  await waitForTabComplete(tabId, Math.min(TOOL_SNAPSHOT_TIMEOUT_MS, 4_000)).catch(() => undefined);

  while (Date.now() < deadline) {
    try {
      const snapshot = await snapshotTab(tabId, options);
      lastSnapshot = snapshot;
      const usefulLength = usefulSnapshotLength(snapshot);
      const signature = snapshotStabilitySignature(snapshot);
      const stable = signature === lastSignature;

      if (usefulLength >= MIN_USEFUL_TOOL_SNAPSHOT_CHARS && (stable || stableCount > 0)) {
        return { snapshot, warnings, status: "success" };
      }

      stableCount = stable ? stableCount + 1 : 0;
      lastSignature = signature;
    } catch (error) {
      lastError = error;
    }

    await delay(TOOL_SNAPSHOT_POLL_MS);
  }

  const fallback = await snapshotFromTabUrlFallback(tab, options).catch((error) => {
    lastError = error;
    return undefined;
  });
  if (fallback) {
    warnings.push(`Visible page snapshot was unavailable or thin${formatSnapshotFallbackCause(lastError)}; used background HTML fallback for extraction.`);
    return {
      snapshot: fallback,
      warnings,
      status: usefulSnapshotLength(fallback) >= MIN_USEFUL_TOOL_SNAPSHOT_CHARS ? "partial" : "partial"
    };
  }

  if (lastSnapshot) {
    warnings.push("Visible page snapshot remained thin after waiting for page content.");
    return { snapshot: lastSnapshot, warnings, status: "partial" };
  }

  if (lastError instanceof Error) {
    warnings.push(`Unable to produce a usable snapshot after retries (${lastError.message}).`);
    return {
      snapshot: fallbackSnapshotForTab(tab, {
        label: "Last tool attempt failed"
      }),
      warnings,
      status: "partial"
    };
  }

  warnings.push("Page snapshot returned no content.");
  return {
    snapshot: fallbackSnapshotForTab(tab, {
      label: "No snapshot content was available"
    }),
    warnings,
    status: "partial"
  };
}

function formatSnapshotFallbackCause(error: unknown): string {
  if (error instanceof Error && error.message) {
    return ` (${error.message})`;
  }

  return "";
}

async function snapshotFromTabUrlFallback(
  tab: chrome.tabs.Tab,
  options: SnapshotToolOptions
): Promise<PageSnapshot | undefined> {
  const url = tab.url;
  if (!url || !/^https:\/\//i.test(url)) {
    return undefined;
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), BACKGROUND_SNAPSHOT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow"
    });
    const contentType = response.headers.get("content-type") ?? "text/html";
    const text = await response.text();
    return snapshotFromFetchedText(response.url || url, text, contentType, options.maxChars, {
      targetedTerms: options.targetedTerms,
      fullTextMaxChars: options.fullTextMaxChars
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function fallbackSnapshotForTab(tab: chrome.tabs.Tab, meta: { label: string }): PageSnapshot {
  const url = tab.url ?? "about:blank";
  return {
    url,
    title: tab.title ?? url,
    description: meta.label,
    headings: [],
    text: "Page snapshot unavailable.",
    fullText: `Page snapshot unavailable for ${url}.`,
    links: []
  };
}

function usefulSnapshotLength(snapshot: PageSnapshot): number {
  return [
    snapshot.text,
    snapshot.fullText,
    snapshot.description,
    snapshot.headings.join("\n"),
    snapshot.tables?.flatMap((table) => table.rows.flat()).join("\n"),
    snapshot.codeBlocks?.map((block) => block.text).join("\n")
  ].filter((value): value is string => Boolean(value)).join("\n").trim().length;
}

function snapshotStabilitySignature(snapshot: PageSnapshot): string {
  return [
    snapshot.url,
    snapshot.title,
    snapshot.text.length,
    snapshot.fullText?.length ?? 0,
    hashText(snapshot.text),
    hashText(snapshot.fullText ?? ""),
    snapshot.headings.join("\u001f"),
    snapshot.links.map((link) => `${link.text}:${link.url}`).join("\u001f"),
    snapshot.priceCandidates?.map((candidate) => candidate.text).join("\u001f") ?? ""
  ].join("|");
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requiredTabId(tab: chrome.tabs.Tab): number {
  if (tab.id === undefined) {
    throw new Error("Tab id is unavailable.");
  }

  return tab.id;
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

function normalizeTabGroupPlans(value: unknown): TabGroupPlan[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser_group_tabs requires at least one group.");
  }

  const usedTabIds = new Set<number>();
  return value.map((item, index) => {
    const record = asRecord(item);
    const tabIds = normalizeTabIds(record.tabIds, `groups[${index}].tabIds`);
    for (const tabId of tabIds) {
      if (usedTabIds.has(tabId)) {
        throw new Error(`Tab ${tabId} appears in more than one requested group.`);
      }
      usedTabIds.add(tabId);
    }

    return {
      title: requiredString(record.title, `groups[${index}].title`).slice(0, 80),
      color: normalizeTabGroupColor(record.color),
      tabIds
    };
  });
}

function normalizeTabIds(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing required tab id array field: ${field}.`);
  }

  const tabIds = value.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0) {
      throw new Error(`Invalid tab id in ${field}.`);
    }
    return item;
  });

  return [...new Set(tabIds)];
}

function normalizeTabGroupColor(value: unknown): chrome.tabGroups.Color | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const color = value.trim().toLowerCase();
  if (!TAB_GROUP_COLORS.has(color)) {
    throw new Error(`Unsupported tab group color: ${value}.`);
  }

  return color as chrome.tabGroups.Color;
}

function tabIdsForChrome(tabIds: number[]): number | [number, ...number[]] {
  if (tabIds.length === 1) {
    return tabIds[0] as number;
  }

  return tabIds as [number, ...number[]];
}

const TAB_GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

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
    metadata: snapshot.metadata,
    headings: snapshot.headings,
    textSample: snapshot.text,
    tables: snapshot.tables,
    codeBlocks: snapshot.codeBlocks,
    forms: snapshot.forms,
    priceCandidates: snapshot.priceCandidates,
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

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Missing required string field: ${field}.`);
  }

  return value;
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function readLineRange(value: unknown): { start?: number; end?: number } | undefined {
  const record = asRecord(value);
  const start = optionalNumber(record.start);
  const end = optionalNumber(record.end);
  return start === undefined && end === undefined ? undefined : { start, end };
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
