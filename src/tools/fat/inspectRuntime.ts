/**
 * Fat tool: inspect_runtime (gather-max, console only for now).
 *
 * Reads the page's runtime console output — console.log/info/warn/error/debug
 * calls plus uncaught errors and unhandled promise rejections — via the existing
 * MAIN-world page-shim pipeline (document_start ring buffer + flush), then emits
 * a deterministic, token-bounded summary for the model. Full buffered entries
 * are returned as fullExtraction for grep recovery.
 *
 * Scope note: this is the console capability. Network traffic is capture_network;
 * DOM/page structure is understand_page. Sources/elements are not built here.
 */

import {
  formatDeterministicConsoleCaptureForLlm,
  runDeterministicConsoleCapturePreflight
} from "../../background/deterministicConsoleCaptureRunner";
import type { ConsoleLevel } from "../networkCapture/consoleBuffer";
import type { FatToolResult, FatToolStatus } from "./fatToolTypes";

export type InspectRuntimeInput = {
  tabId?: number;
  levels?: ConsoleLevel[];
  includeStacks?: boolean;
};

export async function runInspectRuntime(input: InspectRuntimeInput = {}): Promise<FatToolResult> {
  const preflight = await runDeterministicConsoleCapturePreflight({
    tabId: input.tabId,
    levels: input.levels,
    includeStacks: input.includeStacks
  });
  const bundle = preflight.bundle;

  const status: FatToolStatus =
    bundle.status === "completed" ? "success" : bundle.status === "partial" ? "partial" : "failed";

  return {
    tool: "inspect_runtime",
    status,
    summary: formatDeterministicConsoleCaptureForLlm(bundle),
    fullExtraction: { bundle },
    warnings: bundle.warnings,
    error: bundle.status === "failed" ? bundle.errors[0] : undefined,
    // blocked ONLY on a genuine inability to capture (no tab / shim could not
    // install). An empty console on a working capture is a successful result,
    // never blocked.
    meta: bundle.captureBlocked
      ? { blocked: true, blockedReason: bundle.blockedReason }
      : undefined
  };
}
