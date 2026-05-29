/**
 * Per-task research tab.
 *
 * A single search task reuses ONE tab for the search-results page and every
 * result page it opens: search → result 1 → result 2 … all navigate the same
 * tab. A new task (new turn) starts fresh and gets a new tab.
 *
 * The pipeline resets this at the start of each turn (resetResearchTab). The
 * search tool records the tab it opened (setResearchTabId); the page-opening
 * tool reads it (getResearchTabId) and navigates that same tab instead of
 * spawning a new one.
 */

let researchTabId: number | undefined;

/** Start a new task: forget any prior task's research tab. */
export function resetResearchTab(): void {
  researchTabId = undefined;
}

/** Record the tab this task is using for search + result pages. */
export function setResearchTabId(tabId: number | undefined): void {
  if (typeof tabId === "number") {
    researchTabId = tabId;
  }
}

/** The current task's research tab, if one has been opened this turn. */
export function getResearchTabId(): number | undefined {
  return researchTabId;
}
