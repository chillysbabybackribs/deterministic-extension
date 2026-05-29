/**
 * Fat tool: search_web (gather-max).
 *
 * Runs a background web search and returns a compact, ranked-enough list of
 * CANDIDATE result links for the model to choose from. The search-results page
 * is NOT the destination — it is mined for the top real result links; the model
 * then opens the link(s) it wants with understand_page (which navigates to the
 * URL as a visible page, where the per-page overlay spine runs). Sufficiency is
 * decided by the pipeline gate, so the model opens as many or as few result
 * pages as the task needs.
 *
 * Candidate extraction is intent-free: dedupe + drop Google utility/infra links
 * (candidatesFromLinks). No SearchIntent scoring — the model picks.
 */

import { executeBrowserTool, type BrowserToolExecution } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { candidatesFromLinks } from "./searchCandidates";
import { setResearchTabId } from "../researchTab";
import type { SearchCandidate } from "../../evidence/evidenceTypes";
import { buildSummary, isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";

export type SearchWebInput = {
  query: string;
  searchType?: "web" | "images";
};

/** How many candidate links to surface to the model. A bounded shortlist. */
const MAX_CANDIDATES = 8;

export async function runSearchWeb(input: SearchWebInput): Promise<FatToolResult> {
  const exec = await executeBrowserTool({
    id: makeId("search"),
    name: "web_search",
    input: {
      query: input.query,
      searchType: input.searchType === "images" ? "images" : "web",
      includeSnapshot: true,
      // Mine the results page in the background — the user only sees the result
      // pages the model later opens, not the SERP itself.
      background: true
    }
  });

  const status: FatToolStatus =
    exec.status === "failed" ? "failed" : exec.status === "partial" ? "partial" : "success";

  // Record the (background) search tab so result pages reuse this ONE tab for the
  // whole task — search → result 1 → result 2 … all navigate the same tab.
  const out = isRecord(exec.output) ? exec.output : {};
  const searchTab = isRecord(out.tab) ? out.tab : undefined;
  if (searchTab && typeof searchTab.id === "number") {
    setResearchTabId(searchTab.id);
  }

  return {
    tool: "search_web",
    status,
    summary: summarize(input.query, exec),
    fullExtraction: { query: input.query, output: exec.output, candidates: extractCandidates(exec) },
    warnings: exec.warnings,
    error: exec.status === "failed" ? (exec.error ?? exec.summary) : undefined
  };
}

/** Pull clean candidate links from the search-results snapshot (intent-free). */
function extractCandidates(exec: BrowserToolExecution): SearchCandidate[] {
  const out = isRecord(exec.output) ? exec.output : {};
  const snapshot = isRecord(out.snapshot) ? out.snapshot : undefined;
  const rawLinks = snapshot && Array.isArray(snapshot.links) ? snapshot.links : [];
  const links = rawLinks
    .filter(isRecord)
    .map((l) => ({ text: typeof l.text === "string" ? l.text : "", url: typeof l.url === "string" ? l.url : "" }))
    .filter((l) => l.url);
  return candidatesFromLinks(links, MAX_CANDIDATES);
}

function summarize(query: string, exec: BrowserToolExecution): string {
  const out = isRecord(exec.output) ? exec.output : {};
  const imageResults = isRecord(out.imageResults) ? out.imageResults : undefined;

  if (imageResults) {
    const images = Array.isArray(imageResults.images) ? imageResults.images : [];
    return buildSummary([
      `Image search for "${query}": ${images.length} result(s).`,
      ...images.slice(0, 24).map((img) => {
        const i = isRecord(img) ? img : {};
        return `- ${String(i.title ?? "image")}${i.source ? ` (${String(i.source)})` : ""}`;
      })
    ]);
  }

  const candidates = extractCandidates(exec);
  return buildSummary([
    `Web search for "${query}" found ${candidates.length} candidate result link(s).`,
    candidates.length
      ? "Top results (open one with understand_page using its url to read the page; the overlay maps it automatically):"
      : "No usable result links were found.",
    ...candidates.map((c, i) => `  ${i + 1}. ${c.title} — ${c.url}`)
  ]);
}
