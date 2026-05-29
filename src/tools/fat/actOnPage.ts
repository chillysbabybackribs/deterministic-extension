/**
 * Fat tool: act_on_page (intent-driven).
 *
 * Performs a requested sequence of page interactions and verifies the result.
 * Unlike the gatherers, this does NOT do everything in its domain — clicking/
 * typing are irreversible, so it does exactly what was asked. It observes
 * before and after so the summary reports what changed.
 */

import { executeBrowserTool, type BrowserToolExecution, type PageActionTarget } from "../browserToolExecutor";
import { makeId } from "../../shared/id";
import { buildSummary, isRecord, type FatToolResult, type FatToolStatus } from "./fatToolTypes";
import { showActionableOverlay, type OverlayCaptureResult } from "../elementOverlay";

export type PageActionStep = {
  action: "click" | "type" | "select" | "press_key" | "scroll";
  target?: PageActionTarget;
  text?: string;
  value?: string;
  optionText?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
};

export type ActOnPageInput = {
  tabId?: number;
  steps: PageActionStep[];
  /**
   * Fresh overlay capture from the interaction fast-path. When present, the
   * overlay has already been painted for this immediate page interaction, so we
   * can reuse the structured map without scanning/painting the same page again.
   */
  prefetchedActionableMap?: OverlayCaptureResult;
  /**
   * A before-action observation started while the planner was authorizing the
   * action. If it is still fresh and matches the mapped page, reuse it so the
   * action can begin without another full observe pass.
   */
  prefetchedBeforeObservation?: PrefetchedBeforeObservation;
};

export type PrefetchedBeforeObservation = {
  startedAtMs: number;
  promise: Promise<BrowserToolExecution>;
};

const TOOL_BY_ACTION: Record<PageActionStep["action"], string> = {
  click: "browser_click",
  type: "browser_type",
  select: "browser_select",
  press_key: "browser_press_key",
  scroll: "browser_scroll_page"
};
const PREFETCHED_BEFORE_MAX_AGE_MS = 8_000;

export async function runActOnPage(input: ActOnPageInput): Promise<FatToolResult> {
  const tabArg = input.tabId !== undefined ? { tabId: input.tabId } : {};
  const warnings: string[] = [];
  const runs: BrowserToolExecution[] = [];

  if (!input.steps?.length) {
    return {
      tool: "act_on_page",
      status: "failed",
      summary: "No interaction steps were provided.",
      fullExtraction: {},
      warnings: [],
      error: "act_on_page requires at least one step."
    };
  }

  // MANDATORY first step of every page interaction: capture (and paint) the
  // actionable-element map of the page before acting. This is the deterministic
  // "observe" surface the action then targets. Best-effort painting — a capture
  // failure must never block the requested action — but it is always attempted.
  let actionableMap = input.prefetchedActionableMap;
  if (!actionableMap) {
    try {
      actionableMap = await showActionableOverlay(input.tabId);
    } catch (error) {
      warnings.push(`Actionable overlay capture skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const before = await resolveBeforeObservation(input.prefetchedBeforeObservation, input.prefetchedActionableMap, tabArg);
  runs.push(before);

  const stepResults: Array<{ step: PageActionStep; status: string; summary: string; error?: string }> = [];
  for (const step of input.steps) {
    const toolName = TOOL_BY_ACTION[step.action];
    const stepInput: Record<string, unknown> = { ...tabArg, includeObservation: false };
    if (step.target) {
      stepInput.target = step.target;
    }
    if (step.text !== undefined) {
      stepInput.text = step.text;
    }
    if (step.value !== undefined) {
      stepInput.value = step.value;
    }
    if (step.optionText !== undefined) {
      stepInput.optionText = step.optionText;
    }
    if (step.key !== undefined) {
      stepInput.key = step.key;
    }
    if (step.direction !== undefined) {
      stepInput.direction = step.direction;
    }

    const exec = await executeBrowserTool({ id: makeId("act"), name: toolName, input: stepInput }, { allowPageActions: true });
    runs.push(exec);
    warnings.push(...exec.warnings);
    stepResults.push({ step, status: exec.status, summary: exec.summary, error: exec.error });
    if (exec.status === "failed") {
      break; // stop the sequence on first failure
    }
  }

  // NOTE: the overlay is intentionally LEFT PAINTED here. It is torn down once at
  // the END of the whole turn (pipelineRunner's finally), so the user can see the
  // map for the full response, not just the sub-second action window. The overlay
  // is aria-hidden + pointer-events:none, so leaving it up does not affect the
  // "after" observation or intercept anything.
  const after = await executeBrowserTool({ id: makeId("act"), name: "browser_observe_page", input: { ...tabArg } });
  runs.push(after);

  const actionRuns = stepResults;
  const status: FatToolStatus = actionRuns.every((r) => r.status === "success")
    ? "success"
    : actionRuns.some((r) => r.status === "failed")
      ? (actionRuns.some((r) => r.status !== "failed") ? "partial" : "failed")
      : "partial";

  const summary = buildSummary([
    actionableMap
      ? `Mapped ${actionableMap.elements.length} actionable element(s) before acting${actionableMap.droppedByDedup ? ` (${actionableMap.droppedByDedup} nested container(s) deduped)` : ""}.`
      : "Actionable overlay was not available.",
    ...(actionableMap ? renderActionableMap(actionableMap) : []),
    `Performed ${actionRuns.length} of ${input.steps.length} interaction step(s).`,
    ...actionRuns.map((r, i) => `- step ${i + 1} (${r.step.action}): ${r.status}${r.error ? ` — ${r.error}` : ` — ${r.summary}`}`),
    summarizeAfter(after)
  ]);

  return {
    tool: "act_on_page",
    status,
    summary,
    fullExtraction: {
      actionableMap,
      before: before.output,
      steps: stepResults,
      after: after.output
    },
    warnings: uniq(warnings),
    error: status === "failed" ? (actionRuns.find((r) => r.error)?.error ?? "Page action failed.") : undefined
  };
}

async function resolveBeforeObservation(
  prefetched: PrefetchedBeforeObservation | undefined,
  actionableMap: OverlayCaptureResult | undefined,
  tabArg: Record<string, unknown>
): Promise<BrowserToolExecution> {
  if (prefetched && Date.now() - prefetched.startedAtMs <= PREFETCHED_BEFORE_MAX_AGE_MS) {
    try {
      const before = await prefetched.promise;
      if (before.status !== "failed" && observationMatchesActionableMap(before, actionableMap)) {
        return before;
      }
    } catch {
      // Fall back to the ordinary just-in-time observation.
    }
  }

  return executeBrowserTool({ id: makeId("act"), name: "browser_observe_page", input: { ...tabArg } });
}

function observationMatchesActionableMap(
  before: BrowserToolExecution,
  actionableMap: OverlayCaptureResult | undefined
): boolean {
  if (!actionableMap?.url) {
    return true;
  }
  const observedUrl = urlFromExecutionOutput(before.output) ?? before.focusedTab?.url;
  return !observedUrl || observedUrl === actionableMap.url;
}

function urlFromExecutionOutput(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  const tab = output.tab;
  if (isRecord(tab) && typeof tab.url === "string") {
    return tab.url;
  }
  const observation = output.observation;
  if (isRecord(observation) && typeof observation.url === "string") {
    return observation.url;
  }
  return undefined;
}

/**
 * Render the actionable map as a compact, legible numbered list for the summary,
 * so the model (and the user) see exactly what each badge index is, its state,
 * and where a link goes. Capped so a dense page stays bounded.
 */
function renderActionableMap(map: OverlayCaptureResult): string[] {
  const MAX = 40;
  const lines: string[] = ["Actionable map (index → element):"];
  for (const el of map.elements.slice(0, MAX)) {
    const name = el.accessibleName ? `"${el.accessibleName}"` : "(no name)";
    const role = el.role ?? el.tagName;
    const state = [
      el.isEnabled ? undefined : "disabled",
      el.inViewport ? undefined : "off-screen",
      el.accessibleNameSource === "none" ? "unlabeled" : undefined
    ].filter(Boolean).join(",");
    const dest = el.link
      ? ` → ${el.link.rel === "external" ? `[external] ${el.link.origin}${el.link.path}` : el.link.path}${el.link.target ? ` (${el.link.target})` : ""}${el.link.isDownload ? " [download]" : ""}`
      : "";
    lines.push(`  #${el.index} ${role} ${name}${state ? ` [${state}]` : ""}${dest}`);
  }
  if (map.elements.length > MAX) {
    lines.push(`  …and ${map.elements.length - MAX} more (full list in fullExtraction.actionableMap).`);
  }
  return lines;
}

function summarizeAfter(exec: BrowserToolExecution): string | undefined {
  const out = isRecord(exec.output) ? exec.output : {};
  const obs = isRecord(out.observation) ? out.observation : undefined;
  const title = obs && typeof obs.title === "string" ? obs.title : undefined;
  const url = obs && typeof obs.url === "string" ? obs.url : undefined;
  return title || url ? `After: ${title ?? ""} ${url ? `(${url})` : ""}`.trim() : undefined;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
