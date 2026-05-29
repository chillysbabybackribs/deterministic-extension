/**
 * Deterministic console-capture runner.
 *
 * Sibling to {@link ./deterministicNetworkCaptureRunner.ts}. It reuses the SAME
 * MAIN-world page-shim pipeline (document_start registration + pre-start ring
 * buffer + flush), but reads console entries instead of network requests:
 *   ensure shim -> start console capture (flush pre-start) -> settle -> summarize.
 *
 * Only the COMPACT summary built here ever reaches the model. Full buffered
 * console entries stay in memory for the grep/extraction recovery layer.
 *
 * Capture is page-context only (no chrome.debugger / CDP). The accepted, inherent
 * limitation is that console output produced in other contexts (e.g. a service
 * worker, or before the document_start shim could install on a non-matching
 * scheme) is not visible — this runner does not work around that and never
 * blames a disabled capability in its narrative.
 */

import { delay } from "../shared/asyncUtils";
import { makeId } from "../shared/id";
import type { RunProgressEvent } from "../shared/protocol";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import { executeBrowserTool } from "../tools/browserToolExecutor";
import {
  ensureShimContentScripts,
  startPageConsoleCapture,
  stopPageConsoleCapture
} from "../tools/networkCapture/pageShimCapture";
import {
  buildConsoleSummary,
  getConsoleBuffer,
  type ConsoleLevel,
  type ConsoleSummary
} from "../tools/networkCapture/consoleBuffer";
import type { RunControl } from "./runControl";

const SETTLE_POLL_MS = 300;
const SETTLE_QUIET_MS = 1_000;
const SETTLE_MAX_MS = 6_000;

export type DeterministicConsoleCaptureBundle = {
  id: string;
  tabId: number;
  startedAt: string;
  completedAt: string;
  status: "completed" | "partial" | "failed";
  /** Levels the summary was asked to surface beyond the default error+warn. */
  includeLevels: ConsoleLevel[];
  includeStacks: boolean;
  summary?: ConsoleSummary;
  /**
   * True ONLY when console capture genuinely could not run (no tab / the shim
   * could not install). An empty console on a working capture is NOT blocked.
   */
  captureBlocked: boolean;
  blockedReason: string;
  warnings: string[];
  errors: string[];
};

export type DeterministicConsoleCapturePreflight = {
  bundle: DeterministicConsoleCaptureBundle;
  activity: ExecutionLogEntry[];
};

export async function runDeterministicConsoleCapturePreflight(args: {
  tabId?: number;
  levels?: ConsoleLevel[];
  includeStacks?: boolean;
  onProgress?: (event: RunProgressEvent) => void;
  control?: RunControl;
}): Promise<DeterministicConsoleCapturePreflight> {
  const activity: ExecutionLogEntry[] = [];
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const includeLevels = normalizeLevels(args.levels);
  const includeStacks = args.includeStacks ?? false;

  const emit = (event: Omit<RunProgressEvent, "id" | "timestamp">) => {
    args.onProgress?.({ id: makeId("progress"), timestamp: new Date().toISOString(), ...event });
  };
  const log = (entry: Omit<ExecutionLogEntry, "id" | "timestamp">) => {
    activity.push({ id: makeId("log"), timestamp: new Date().toISOString(), ...entry });
  };

  // 1. Resolve target tab.
  let tabId = args.tabId;
  if (tabId === undefined) {
    const tabResult = await executeBrowserTool({ id: makeId("con"), name: "browser_read_active_tab", input: {} });
    const output = tabResult.output as { tab?: { id?: number } } | undefined;
    tabId = output?.tab?.id;
  }
  if (tabId === undefined) {
    return failBundle("No active tab to read console output from.");
  }

  // 2. Ensure the document_start shim is registered (covers future loads) and
  //    start console capture on this tab (flushes any pre-start buffer).
  emit({ level: "info", label: "Console", detail: `Reading console on tab ${tabId}.`, status: "running" });
  try {
    await ensureShimContentScripts();
    await startPageConsoleCapture(tabId);
  } catch (error) {
    return failBundle(
      error instanceof Error ? error.message : "Console capture could not start.",
      tabId
    );
  }

  // 3. Settle: let any in-flight console output land (buffer stops growing).
  await settleUntilQuiet(tabId, args.control);

  // 4. Build the compact summary deterministically.
  const buffer = getConsoleBuffer(tabId);
  const summary = buffer ? buildConsoleSummary(buffer, includeLevels) : undefined;

  // 5. Stop the console capture (the buffer is retained for grep recovery).
  stopPageConsoleCapture(tabId);

  const completedAt = new Date().toISOString();
  const errorCount = summary?.errorCount ?? 0;
  const warnCount = summary?.warnCount ?? 0;
  emit({
    level: "info",
    label: "Console",
    detail: `Captured ${errorCount} error(s), ${warnCount} warning(s).`,
    status: "completed"
  });

  const bundle: DeterministicConsoleCaptureBundle = {
    id: makeId("console_capture"),
    tabId,
    startedAt,
    completedAt,
    // A working capture with no errors/warnings is a successful "clean" result.
    status: "completed",
    includeLevels,
    includeStacks,
    summary,
    captureBlocked: false,
    blockedReason: "",
    warnings,
    errors
  };
  return { bundle, activity };

  function failBundle(message: string, failedTabId?: number): DeterministicConsoleCapturePreflight {
    errors.push(message);
    emit({ level: "error", label: "Console", detail: message, status: "failed" });
    return {
      bundle: {
        id: makeId("console_capture"),
        tabId: failedTabId ?? -1,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "failed",
        includeLevels,
        includeStacks,
        captureBlocked: true,
        blockedReason: `Console capture could not run: ${message}`,
        warnings,
        errors
      },
      activity
    };
  }
}

function normalizeLevels(levels: ConsoleLevel[] | undefined): ConsoleLevel[] {
  const allowed: ConsoleLevel[] = ["error", "warn", "info", "debug", "log"];
  if (!levels || levels.length === 0) {
    return ["error", "warn"];
  }
  const set = new Set<ConsoleLevel>();
  for (const level of levels) {
    if (allowed.includes(level)) {
      set.add(level);
    }
  }
  // error+warn are always part of the visible set; ensure they are present.
  set.add("error");
  set.add("warn");
  return [...set];
}

/** Poll the console buffer size; resolve once quiet for SETTLE_QUIET_MS. */
async function settleUntilQuiet(tabId: number, control?: RunControl): Promise<void> {
  const deadline = Date.now() + SETTLE_MAX_MS;
  let lastCount = consoleEntryCount(tabId);
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await control?.checkpoint();
    await delay(SETTLE_POLL_MS);
    const count = consoleEntryCount(tabId);
    if (count !== lastCount) {
      lastCount = count;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= SETTLE_QUIET_MS) {
      return;
    }
  }
}

function consoleEntryCount(tabId: number): number {
  return getConsoleBuffer(tabId)?.entries.length ?? 0;
}

/**
 * Format the compact bundle for the LLM synthesis step. Caps every list so the
 * synthesis prompt stays bounded. Never blames a disabled capability for absent
 * data: an empty result simply reports "no errors or warnings captured".
 */
export function formatDeterministicConsoleCaptureForLlm(bundle: DeterministicConsoleCaptureBundle): string {
  if (bundle.status === "failed" || !bundle.summary) {
    const reason = bundle.errors[0] ?? "Console output could not be read.";
    return `Console capture unavailable: ${reason}`;
  }

  const summary = bundle.summary;
  const lines: string[] = [];

  // Header line with totals (must fit comfortably under FAT_SUMMARY_MAX_CHARS).
  const suppressedNote = summary.suppressedCount
    ? `; ${summary.suppressedCount} info/debug/log suppressed`
    : "";
  lines.push(
    `Console for tab ${bundle.tabId}: ${summary.errorCount} error(s), ${summary.warnCount} warning(s) ` +
      `(${summary.uniqueErrorCount} unique error(s), ${summary.uniqueWarnCount} unique warning(s))${suppressedNote}.`
  );

  if (summary.errorCount === 0 && summary.warnCount === 0 && summary.otherLevels.length === 0) {
    lines.push("No errors or warnings were captured. The page logged no errors or warnings during the captured window.");
    if (summary.suppressedCount) {
      lines.push(`(${summary.suppressedCount} info/debug/log message(s) excluded by level; pass levels to include them.)`);
    }
    return lines.join("\n");
  }

  const MAX_PER_SECTION = 40;
  const renderGroup = (group: ConsoleSummary["pageErrors"][number]): string => {
    const repeat = group.count > 1 ? ` ×${group.count}` : "";
    const top = bundle.includeStacks && group.stack
      ? `\n    ${group.stack.split("\n").slice(0, 12).join("\n    ")}`
      : group.source
        ? ` (at ${group.source})`
        : "";
    const message = group.message.length > 300 ? `${group.message.slice(0, 300)}…` : group.message;
    return `- ${message}${repeat}${top}`;
  };

  if (summary.pageErrors.length) {
    lines.push("", `Uncaught page errors / rejections (${Math.min(summary.pageErrors.length, MAX_PER_SECTION)} of ${summary.pageErrors.length}):`);
    for (const group of summary.pageErrors.slice(0, MAX_PER_SECTION)) {
      lines.push(renderGroup(group));
    }
  }

  if (summary.consoleErrors.length) {
    lines.push("", `console.error calls (${Math.min(summary.consoleErrors.length, MAX_PER_SECTION)} of ${summary.consoleErrors.length}):`);
    for (const group of summary.consoleErrors.slice(0, MAX_PER_SECTION)) {
      lines.push(renderGroup(group));
    }
  }

  if (summary.consoleWarns.length) {
    lines.push("", `console.warn calls (${Math.min(summary.consoleWarns.length, MAX_PER_SECTION)} of ${summary.consoleWarns.length}):`);
    for (const group of summary.consoleWarns.slice(0, MAX_PER_SECTION)) {
      lines.push(renderGroup(group));
    }
  }

  if (summary.otherLevels.length) {
    lines.push("", `Other requested levels (${Math.min(summary.otherLevels.length, MAX_PER_SECTION)} of ${summary.otherLevels.length}):`);
    for (const group of summary.otherLevels.slice(0, MAX_PER_SECTION)) {
      lines.push(`- [${group.level}] ${renderGroup(group).slice(2)}`);
    }
  }

  if (summary.droppedEntries) {
    lines.push("", `Note: ${summary.droppedEntries} oldest entr(ies) were dropped (capture buffer full).`);
  }

  if (bundle.warnings.length) {
    lines.push("", `Warnings: ${bundle.warnings.join(" | ")}`);
  }

  return lines.join("\n");
}
