/**
 * Fat tool: query_file.
 *
 * Deterministically searches the user's attached working file. The file was
 * ingested + indexed once; this runs the corpus search engine for the given
 * query and returns the exact applicable passages/rows with their locations.
 *
 * The corpus lives in panel IndexedDB, so retrieval is delegated to the panel
 * via the `corpus_query` browser tool (same delegate path as the fs_* tools).
 *
 * "The user's prompt is the query": the caller passes the raw user message so
 * retrieval is anchored to the actual prompt, unioned with any narrower terms
 * the planner supplied — regardless of how the model phrases the query arg.
 */

import { executeBrowserTool, type BrowserToolExecution } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { buildSummary, isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";

export type QueryFileInput = {
  /** Query terms from the planner (typically drawn from the user's request). */
  query?: string;
  /** The raw user message, unioned into the query so the prompt anchors retrieval. */
  userMessage?: string;
  /** Widen the search and pull more surrounding context on a re-query. */
  broaden?: boolean;
};

export async function runQueryFile(input: QueryFileInput = {}): Promise<FatToolResult> {
  const query = [input.query ?? "", input.userMessage ?? ""].join(" ").trim();
  const exec: BrowserToolExecution = await executeBrowserTool({
    id: makeId("corpus"),
    name: "corpus_query",
    input: { query, broaden: input.broaden === true }
  });

  const out = isRecord(exec.output) ? exec.output : {};
  const active = out.active === true;

  if (!active) {
    return {
      tool: "query_file",
      status: "partial",
      summary:
        "No source is attached. Ask the user to connect a file or folder (the attach control in the header) before answering questions about their source.",
      fullExtraction: { active: false },
      warnings: ["No source is attached."]
    };
  }

  const fileName = typeof out.fileName === "string" ? out.fileName : "the working source";
  const rendered = typeof out.rendered === "string" ? out.rendered : "";
  const matchCount = typeof out.matchCount === "number" ? out.matchCount : 0;
  const sourceType = out.sourceType === "folder" ? "folder" : "file";
  const building = out.building === true;
  const mode = out.mode === "semantic" ? "semantic" : "keyword";
  const label = sourceType === "folder" ? `Folder ${fileName}` : `File ${fileName}`;
  const buildingNote = building ? " (index still building — a later query may surface more)" : "";

  const summary = buildSummary([
    `${label} — ${matchCount} ${mode} match(es) for this query${input.broaden ? " (broadened)" : ""}.${buildingNote}`,
    rendered
  ]);

  const status: FatToolStatus = matchCount > 0 ? "success" : "partial";

  return {
    tool: "query_file",
    status,
    summary: summary || `No matching passages in ${fileName} for this query.`,
    fullExtraction: { active: true, fileName, sourceType, matchCount, rendered },
    warnings: matchCount === 0 ? ["No matching passages found; a broader query may help."] : []
  };
}
