/**
 * Fat tool: read_workspace (gather-max).
 *
 * Deterministically gathers workspace context: connection status, a directory
 * listing, optional content search, and reads of specifically requested files.
 * Emits a compact summary; the full listing/search/content is fullExtraction.
 */

import { executeBrowserTool, type BrowserToolExecution } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { buildSummary, isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";

export type ReadWorkspaceInput = {
  /** Optional content/name search query to run across the workspace. */
  query?: string;
  /** Optional explicit relative file paths to read in full. */
  readPaths?: string[];
  /** Directory to list/search from. Defaults to the workspace root. */
  path?: string;
};

export async function runReadWorkspace(input: ReadWorkspaceInput = {}): Promise<FatToolResult> {
  const warnings: string[] = [];
  const runs: BrowserToolExecution[] = [];

  const status = await run("fs_get_workspace", {});
  runs.push(status);

  const connected = isWorkspaceConnected(status);
  let listing: BrowserToolExecution | undefined;
  let search: BrowserToolExecution | undefined;
  const reads: BrowserToolExecution[] = [];

  if (connected) {
    listing = await run("fs_list_directory", {
      path: input.path ?? "",
      recursive: true,
      maxEntries: 700
    });
    runs.push(listing);

    if (input.query) {
      search = await run("fs_search_files", {
        query: input.query,
        path: input.path ?? "",
        includeContent: true,
        maxResults: 80
      });
      runs.push(search);
    }

    for (const p of input.readPaths ?? []) {
      const read = await run("fs_read_file", { path: p });
      reads.push(read);
      runs.push(read);
    }
  } else {
    warnings.push("No workspace folder is connected. Connect one in Settings to read local files.");
  }

  for (const r of runs) {
    warnings.push(...r.warnings);
  }

  const fullExtraction: Record<string, unknown> = {
    status: status.output,
    listing: listing?.output,
    search: search?.output,
    reads: reads.map((r) => r.output)
  };

  const summary = buildSummary([
    summarizeStatus(status),
    summarizeListing(listing),
    summarizeSearch(search, input.query),
    ...reads.map(summarizeRead)
  ]);

  const overall: FatToolStatus = !connected
    ? "partial"
    : runs.every((r) => r.status === "failed")
      ? "failed"
      : runs.some((r) => r.status === "failed" || r.status === "partial")
        ? "partial"
        : "success";

  return {
    tool: "read_workspace",
    status: overall,
    summary: summary || "No workspace data gathered.",
    fullExtraction,
    warnings: uniq(warnings),
    error: overall === "failed" ? (runs.find((r) => r.error)?.error ?? "Workspace read failed.") : undefined
  };
}

async function run(name: string, inputObj: Record<string, unknown>): Promise<BrowserToolExecution> {
  return executeBrowserTool({ id: makeId("workspace"), name, input: inputObj });
}

function isWorkspaceConnected(exec: BrowserToolExecution): boolean {
  const out = isRecord(exec.output) ? exec.output : {};
  const ws = isRecord(out.workspace) ? out.workspace : {};
  return ws.connected === true;
}

function summarizeStatus(exec: BrowserToolExecution): string {
  const out = isRecord(exec.output) ? exec.output : {};
  const ws = isRecord(out.workspace) ? out.workspace : {};
  if (ws.connected === true) {
    return `Workspace: ${String(ws.rootName ?? "connected folder")} (read ${String(ws.readPermission ?? "?")}, write ${ws.writeEnabled ? String(ws.writePermission ?? "?") : "off"}).`;
  }
  return "Workspace: no folder connected.";
}

function summarizeListing(exec: BrowserToolExecution | undefined): string | undefined {
  if (!exec) {
    return undefined;
  }
  const out = isRecord(exec.output) ? exec.output : {};
  const entries = Array.isArray(out.entries) ? out.entries : [];
  if (!entries.length) {
    return undefined;
  }
  const names = entries.slice(0, 120).map((e) => {
    const entry = isRecord(e) ? e : {};
    return `- ${String(entry.path ?? entry.name ?? "?")}${entry.kind === "directory" ? "/" : ""}`;
  });
  return ["", `Workspace files (${Math.min(entries.length, 120)} of ${entries.length}):`, ...names].join("\n");
}

function summarizeSearch(exec: BrowserToolExecution | undefined, query?: string): string | undefined {
  if (!exec) {
    return undefined;
  }
  const out = isRecord(exec.output) ? exec.output : {};
  const matches = Array.isArray(out.matches) ? out.matches : [];
  if (!matches.length) {
    return query ? `\nNo workspace matches for "${query}".` : undefined;
  }
  const lines = matches.slice(0, 40).map((m) => {
    const match = isRecord(m) ? m : {};
    const loc = match.line ? `${String(match.path)}:${String(match.line)}` : String(match.path);
    return `- ${loc}${match.preview ? `  ${String(match.preview).slice(0, 120)}` : ""}`;
  });
  return ["", `Matches for "${query}" (${Math.min(matches.length, 40)} of ${matches.length}):`, ...lines].join("\n");
}

function summarizeRead(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const path = typeof out.path === "string" ? out.path : "(file)";
  const text = typeof out.text === "string" ? out.text.slice(0, 4_000) : "";
  return text ? ["", `File ${path}:`, text].join("\n") : undefined;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
