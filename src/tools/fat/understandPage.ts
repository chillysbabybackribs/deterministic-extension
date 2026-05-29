/**
 * Fat tool: understand_page (gather-max).
 *
 * Runs the full page-understanding sweep deterministically — tab metadata, app
 * inspection (DOM/framework/storage/scripts/resource-timing), interactive
 * elements, and readable text — then emits one compact summary. The complete
 * gathered data is returned as fullExtraction for the persistence/grep layer.
 */

import { executeBrowserTool, type BrowserToolExecution } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { getResearchTabId, setResearchTabId } from "../researchTab";
import { buildSummary, isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";
import { waitForPageReadyForExtraction } from "../pageReadiness";

export type UnderstandPageInput = {
  tabId?: number;
  /**
   * When given, open this URL as a VISIBLE page first, then understand it. This
   * is how the model opens a search result link: the page becomes visible (so the
   * per-page overlay spine runs on it) and is then swept. Without a url, the
   * current/active tab is understood in place.
   */
  url?: string;
};

export async function runUnderstandPage(input: UnderstandPageInput = {}): Promise<FatToolResult> {
  const warnings: string[] = [];
  let tabId = input.tabId;

  // Open the URL as a visible page first when one was provided. To keep a single
  // task in ONE tab, reuse this task's research tab (opened by search_web) by
  // navigating it; only open a brand-new tab when there is no research tab yet.
  if (input.url) {
    const researchTabId = getResearchTabId();
    const opened = researchTabId !== undefined
      ? await run("browser_navigate_active_tab", { action: "go_to", url: input.url, tabId: researchTabId })
      : await run("browser_open_tab", { url: input.url, active: true });
    warnings.push(...opened.warnings);
    const openedTab = isRecord(opened.output) && isRecord(opened.output.tab) ? opened.output.tab : undefined;
    const openedId = openedTab && typeof openedTab.id === "number" ? openedTab.id : undefined;
    if (openedId !== undefined) {
      tabId = openedId;
      // If we opened a fresh tab (no research tab yet), adopt it as the task's
      // research tab so any further result pages reuse this same one.
      if (researchTabId === undefined) {
        setResearchTabId(openedId);
      }
    }
  }
  const tabArg = tabId !== undefined ? { tabId } : {};
  const readiness = await waitForPageReadyForExtraction(tabId, {
    reason: "understand_page",
    minWaitMs: input.url ? 650 : 450,
    stableSampleCount: 2,
    timeoutMs: input.url ? 3_500 : 2_500
  });
  warnings.push(...readiness.warnings);

  const tab = await run("browser_read_active_tab", { ...tabArg, includeSnapshot: false });
  const inspection = await run("browser_inspect_page_app", { ...tabArg });
  const observation = await run("browser_observe_page", { ...tabArg });
  const extraction = await run("browser_extract_page", { ...tabArg, includeStructured: true });

  const runs = [tab, inspection, observation, extraction];
  for (const r of runs) {
    warnings.push(...r.warnings);
  }
  const status = foldStatus(runs);

  const fullExtraction: Record<string, unknown> = {
    tab: tab.output,
    inspection: inspection.output,
    observation: observation.output,
    extraction: extraction.output
  };

  const summary = buildSummary([
    summarizeTab(tab),
    summarizeInspection(inspection),
    summarizeObservation(observation),
    summarizeExtraction(extraction)
  ]);

  return {
    tool: "understand_page",
    status,
    summary: summary || "No page understanding could be gathered.",
    fullExtraction,
    warnings: uniq(warnings),
    error: status === "failed" ? (runs.find((r) => r.error)?.error ?? "Page understanding failed.") : undefined
  };
}

async function run(name: string, inputObj: Record<string, unknown>): Promise<BrowserToolExecution> {
  return executeBrowserTool({ id: makeId("understand"), name, input: inputObj });
}

function foldStatus(runs: BrowserToolExecution[]): FatToolStatus {
  if (runs.every((r) => r.status === "failed")) {
    return "failed";
  }
  if (runs.some((r) => r.status === "failed" || r.status === "partial")) {
    return "partial";
  }
  return "success";
}

function summarizeTab(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const tab = isRecord(out.tab) ? out.tab : {};
  const title = typeof tab.title === "string" ? tab.title : "(untitled)";
  const url = typeof tab.url === "string" ? tab.url : "(no url)";
  return `Page: ${title}\nURL: ${url}`;
}

function summarizeInspection(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const insp = isRecord(out.inspection) ? out.inspection : undefined;
  if (!insp) {
    return undefined;
  }
  const dom = isRecord(insp.domSummary) ? insp.domSummary : {};
  const net = isRecord(insp.network) ? insp.network : {};
  const storage = isRecord(insp.storage) ? insp.storage : {};
  const frameworkHints = Array.isArray(insp.frameworkHints) ? insp.frameworkHints : [];
  const forms = Array.isArray(dom.forms) ? dom.forms.length : 0;
  const interactive = Array.isArray(dom.interactiveElements) ? dom.interactiveElements.length : 0;
  const resourceTypes = isRecord(net.resourceCountsByType)
    ? Object.entries(net.resourceCountsByType).map(([t, c]) => `${t}:${c}`).join(", ")
    : "";
  const localKeys = Array.isArray(storage.localStorage) ? storage.localStorage.length : 0;

  return [
    "",
    "App inspection:",
    `- framework: ${frameworkHints.length ? frameworkHints.join(", ") : "none detected"}`,
    `- total DOM elements: ${typeof dom.totalElements === "number" ? dom.totalElements : "?"}`,
    `- forms: ${forms}, interactive controls: ${interactive}`,
    resourceTypes ? `- resource timing: ${resourceTypes}` : undefined,
    `- localStorage keys observed: ${localKeys} (names only; values not captured)`
  ].filter(Boolean).join("\n");
}

function summarizeObservation(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const obs = isRecord(out.observation) ? out.observation : undefined;
  const elements = obs && Array.isArray(obs.elements) ? obs.elements : [];
  if (!elements.length) {
    return undefined;
  }
  const top = elements.slice(0, 40).map((el) => {
    const e = isRecord(el) ? el : {};
    const role = typeof e.role === "string" ? e.role : "el";
    const name = e.name || e.label || e.text || e.selector || "(unnamed)";
    return `- ${role}: ${String(name)}`;
  });
  return ["", `Interactive controls (${Math.min(elements.length, 40)} of ${elements.length}):`, ...top].join("\n");
}

function summarizeExtraction(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const page = isRecord(out.page) ? out.page : undefined;
  if (!page) {
    return undefined;
  }
  const headings = Array.isArray(page.headings) ? page.headings.slice(0, 15) : [];
  const text = typeof page.text === "string" ? page.text.slice(0, 2_000) : "";
  return [
    "",
    headings.length ? `Headings: ${headings.join(" | ")}` : undefined,
    text ? `Text sample:\n${text}` : undefined
  ].filter(Boolean).join("\n");
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
