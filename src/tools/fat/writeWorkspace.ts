/**
 * Fat tool: write_workspace (intent-driven).
 *
 * Writes a named file to the connected workspace. Irreversible, so it does
 * exactly what was asked — no "gather everything". Returns a confirmation
 * summary; fullExtraction records the write result.
 */

import { executeBrowserTool } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";

export type WriteWorkspaceInput = {
  path: string;
  content: string;
  createParents?: boolean;
};

export async function runWriteWorkspace(input: WriteWorkspaceInput): Promise<FatToolResult> {
  if (!input.path || !input.path.trim()) {
    return {
      tool: "write_workspace",
      status: "failed",
      summary: "No file path was provided.",
      fullExtraction: {},
      warnings: [],
      error: "write_workspace requires a path."
    };
  }

  const exec = await executeBrowserTool({
    id: makeId("write"),
    name: "fs_write_file",
    input: {
      path: input.path,
      content: input.content ?? "",
      createParents: input.createParents ?? true
    }
  });

  const status: FatToolStatus = exec.status === "failed" ? "failed" : exec.status === "partial" ? "partial" : "success";
  const out = isRecord(exec.output) ? exec.output : {};
  const writtenPath = typeof out.path === "string" ? out.path : input.path;

  return {
    tool: "write_workspace",
    status,
    summary: status === "failed"
      ? `Could not write ${input.path}: ${exec.error ?? exec.summary}`
      : `Wrote ${writtenPath}.`,
    fullExtraction: { result: exec.output },
    warnings: exec.warnings,
    error: status === "failed" ? (exec.error ?? exec.summary) : undefined
  };
}
