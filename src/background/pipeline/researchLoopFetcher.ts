/**
 * Production page fetcher for the research loop.
 *
 * Navigates the task's SINGLE working tab to a result URL and returns its
 * snapshot — reusing the research tab (so search → result 1 → result 2 … all
 * stay in one tab), exactly like understand_page's url path. Kept separate from
 * researchLoop.ts so the loop orchestration stays unit-testable without a real
 * browser: the loop takes this as an injected `FetchPage`.
 */

import { executeBrowserTool } from "../../tools/browserToolExecutor";
import { makeId } from "../../shared/id";
import { getResearchTabId, setResearchTabId } from "../../tools/researchTab";
import { waitForPageReadyForExtraction } from "../../tools/pageReadiness";
import { isRecord } from "../../tools/fat/fatToolTypes";
import type { PageSnapshot } from "../../tools/snapshot/pageSnapshotTypes";
import type { FetchedPage } from "./researchLoop";

/** Navigate the working tab to `url`, wait for readiness, and snapshot it. */
export async function fetchResearchPage(url: string): Promise<FetchedPage | undefined> {
  const warnings: string[] = [];

  // Reuse this task's research tab (opened by search_web); only open a new tab if
  // none exists yet, then adopt it so later results reuse the same one.
  const researchTabId = getResearchTabId();
  const opened = researchTabId !== undefined
    ? await run("browser_navigate_active_tab", { action: "go_to", url, tabId: researchTabId })
    : await run("browser_open_tab", { url, active: true });
  warnings.push(...opened.warnings);

  const openedTab = isRecord(opened.output) && isRecord(opened.output.tab) ? opened.output.tab : undefined;
  const tabId = openedTab && typeof openedTab.id === "number" ? openedTab.id : researchTabId;
  if (tabId === undefined) {
    return undefined;
  }
  if (researchTabId === undefined) {
    setResearchTabId(tabId);
  }

  const readiness = await waitForPageReadyForExtraction(tabId, {
    reason: "research_loop",
    minWaitMs: 650,
    stableSampleCount: 2,
    timeoutMs: 3_500
  });
  warnings.push(...readiness.warnings);

  const extraction = await run("browser_extract_page", { tabId, includeStructured: true });
  warnings.push(...extraction.warnings);
  const out = isRecord(extraction.output) ? extraction.output : {};
  const page = isRecord(out.page) ? (out.page as unknown as PageSnapshot) : undefined;
  if (!page) {
    return undefined;
  }

  return { url: page.url || url, snapshot: page, warnings };
}

async function run(name: string, input: Record<string, unknown>) {
  return executeBrowserTool({ id: makeId("research"), name, input });
}
