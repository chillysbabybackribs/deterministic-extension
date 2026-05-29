/**
 * Executes a plan's steps by dispatching to the fat tools, persists each result
 * to the extraction store, and returns the per-step results. Pure deterministic
 * execution — no model here.
 */

import {
  runUnderstandPage,
  runCaptureNetworkFat,
  runInspectRuntime,
  runSearchWeb,
  runReadWorkspace,
  runQueryFile,
  runActOnPage,
  runWriteWorkspace,
  saveExtraction,
  grepExtractions,
  type FatToolResult,
  type PrefetchedBeforeObservation,
  type PageActionStep
} from "../../tools/fat";
import type { ConsoleLevel } from "../../tools/networkCapture/consoleBuffer";
import { runPageCorpusPass } from "../../tools/pageCorpusPass";
import type { OverlayCaptureResult } from "../../tools/elementOverlay";
import type { Plan, PlanStep } from "./planner";

/**
 * Plan tools that OPEN a visible page. After these run, the ubiquitous
 * overlay→corpus→grep pass paints that page and folds the element map into the
 * step summary — so the overlay runs per page and the model always plans the next
 * step with the page already mapped.
 *
 * Only understand_page is here: it opens a result link as a visible page (the
 * standard "open a search result" path). search_web is NOT — it now runs in a
 * BACKGROUND tab, so there is no visible page to overlay after it; the overlay
 * fires when the model opens a result link via understand_page. act_on_page is
 * NOT here either — it paints its own overlay internally before acting.
 */
const PAGE_OPENING_TOOLS: ReadonlySet<PlanStep["tool"]> = new Set(["understand_page"]);
const PAGE_STATE_DEPENDENT_TOOLS: ReadonlySet<PlanStep["tool"]> = new Set([
  "understand_page",
  "capture_network",
  "inspect_runtime",
  "act_on_page"
]);

export type DeferredPlanBoundary = "post_action" | "post_open_or_map" | "post_reload";

export type DeferredPlanSteps = {
  boundary: DeferredPlanBoundary;
  reason: string;
  steps: PlanStep[];
};

export type ExecutedStep = {
  tool: PlanStep["tool"];
  summary: string;
  status: FatToolResult["status"] | "grep";
  warnings: string[];
  /** The exact args this step ran with — used to detect no-progress repeats. */
  args: Record<string, unknown>;
  /** Structured signals (e.g. blocked) propagated from the fat tool. */
  meta?: FatToolResult["meta"];
  /** Planned steps paused at a page-state boundary. The pipeline may auto-resume them. */
  deferred?: DeferredPlanSteps;
};

/** Per-run context fat tools may need (e.g. the raw prompt to anchor file search). */
export type ExecuteContext = {
  userMessage?: string;
  /** Fresh overlay map captured before planning for an immediate interaction. */
  prefetchedActionableMap?: OverlayCaptureResult;
  /** Fresh before-action observation started while the planner was thinking. */
  prefetchedBeforeObservation?: PrefetchedBeforeObservation;
  /** Add model-facing deferred-step text to the last summary. Default true. */
  annotateDeferrals?: boolean;
};

export async function executePlan(
  taskId: string,
  plan: Plan,
  context: ExecuteContext = {}
): Promise<ExecutedStep[]> {
  const executed: ExecutedStep[] = [];
  let prefetchedActionableMap = context.prefetchedActionableMap;
  let prefetchedBeforeObservation = context.prefetchedBeforeObservation;
  const pageState = {
    openedOrMappedThisRound: false,
    actedThisRound: false,
    reloadedThisRound: false
  };

  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
    const step = plan.steps[stepIndex];
    const deferred = deferralBeforeStep(step, plan.steps.length - stepIndex, pageState);
    if (deferred) {
      appendDeferralToLastExecutedStep(
        executed,
        { ...deferred, steps: plan.steps.slice(stepIndex) },
        context.annotateDeferrals !== false
      );
      break;
    }

    if (step.tool === "grep_extractions") {
      const query = String(step.args.query ?? "");
      const tool = typeof step.args.tool === "string" ? (step.args.tool as FatToolResult["tool"]) : undefined;
      const matches = await grepExtractions(taskId, query, tool ? { tool } : {});
      const summary = matches.length
        ? `Grep "${query}" found ${matches.length} match(es):\n` +
          matches.slice(0, 40).map((m) => `- ${m.tool} @ ${m.path}: ${m.value}`).join("\n")
        : `Grep "${query}" found no matches in gathered data.`;
      executed.push({ tool: step.tool, summary, status: "grep", warnings: [], args: step.args });
      continue;
    }

    const stepPrefetchedActionableMap = step.tool === "act_on_page" ? prefetchedActionableMap : undefined;
    const stepPrefetchedBeforeObservation = step.tool === "act_on_page" ? prefetchedBeforeObservation : undefined;
    prefetchedActionableMap = undefined;
    prefetchedBeforeObservation = undefined;
    const result = await runFatTool(step, context, stepPrefetchedActionableMap, stepPrefetchedBeforeObservation);

    // UBIQUITOUS PER-PAGE SPINE: when the step opened a page, paint the overlay
    // and grep the corpus on it, then fold the element map into the summary so
    // the model sees the mapped page (never blind) on the next plan. Best-effort
    // — a skipped overlay (chrome://, blocked) never affects the tool result.
    let summary = result.summary;
    if (PAGE_OPENING_TOOLS.has(step.tool) && result.status !== "failed") {
      const target = typeof step.args.query === "string" ? step.args.query : undefined;
      const pass = await runPageCorpusPass({ target });
      if (pass.kind === "captured") {
        summary = `${summary}\n\n${pass.summary}`;
      }
    }

    await saveExtraction(taskId, result);
    executed.push({ tool: step.tool, summary, status: result.status, warnings: result.warnings, args: step.args, meta: result.meta });
    updatePageStateBarrier(step, pageState);
  }
  return executed;
}

async function runFatTool(
  step: PlanStep,
  context: ExecuteContext,
  prefetchedActionableMap?: OverlayCaptureResult,
  prefetchedBeforeObservation?: PrefetchedBeforeObservation
): Promise<FatToolResult> {
  const a = step.args;
  switch (step.tool) {
    case "understand_page":
      return runUnderstandPage({
        tabId: numberArg(a.tabId),
        url: typeof a.url === "string" ? a.url : undefined
      });
    case "capture_network":
      return runCaptureNetworkFat({ tabId: numberArg(a.tabId) });
    case "inspect_runtime":
      return runInspectRuntime({
        tabId: numberArg(a.tabId),
        levels: Array.isArray(a.levels)
          ? a.levels.filter((l): l is ConsoleLevel => l === "error" || l === "warn" || l === "info" || l === "debug" || l === "log")
          : undefined,
        includeStacks: a.includeStacks === true || a.includeStacks === "true"
      });
    case "search_web":
      return runSearchWeb({ query: String(a.query ?? ""), searchType: a.searchType === "images" ? "images" : "web" });
    case "read_workspace":
      return runReadWorkspace({
        query: typeof a.query === "string" ? a.query : undefined,
        readPaths: Array.isArray(a.readPaths) ? a.readPaths.filter((p): p is string => typeof p === "string") : undefined,
        path: typeof a.path === "string" ? a.path : undefined
      });
    case "query_file":
      return runQueryFile({
        query: typeof a.query === "string" ? a.query : undefined,
        userMessage: context.userMessage,
        broaden: a.broaden === true || a.broaden === "true"
      });
    case "act_on_page":
      return runActOnPage({
        tabId: numberArg(a.tabId),
        steps: Array.isArray(a.steps) ? (a.steps as PageActionStep[]) : [],
        prefetchedActionableMap,
        prefetchedBeforeObservation
      });
    case "write_workspace":
      return runWriteWorkspace({ path: String(a.path ?? ""), content: String(a.content ?? "") });
    default:
      return {
        tool: "understand_page",
        status: "failed",
        summary: `Unknown tool in plan: ${String(step.tool)}`,
        fullExtraction: {},
        warnings: [],
        error: `Unknown tool: ${String(step.tool)}`
      };
  }
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type PageStateBarrier = {
  openedOrMappedThisRound: boolean;
  actedThisRound: boolean;
  reloadedThisRound: boolean;
};

function updatePageStateBarrier(step: PlanStep, state: PageStateBarrier): void {
  if (step.tool === "understand_page") {
    state.openedOrMappedThisRound = true;
  }
  if (step.tool === "act_on_page") {
    state.actedThisRound = true;
  }
  if (step.tool === "capture_network") {
    state.reloadedThisRound = true;
  }
}

function deferralBeforeStep(
  step: PlanStep,
  remainingStepCount: number,
  state: PageStateBarrier
): Omit<DeferredPlanSteps, "steps"> | undefined {
  if (state.actedThisRound && PAGE_STATE_DEPENDENT_TOOLS.has(step.tool)) {
    return {
      boundary: "post_action",
      reason: [
        `Deferred ${remainingStepCount} planned page-dependent step(s) until the next planning round because act_on_page changed the visible page state.`,
        "The next plan will receive the fresh current tab and actionable map; choose replan if the user still needs the deferred page work."
      ].join(" ")
    };
  }

  if (step.tool === "act_on_page" && state.reloadedThisRound) {
    return {
      boundary: "post_reload",
      reason: [
        `Deferred ${remainingStepCount} planned page-action step(s) until the next planning round because capture_network reloaded the visible page.`,
        "The next plan will use the post-reload actionable map before acting."
      ].join(" ")
    };
  }

  if (step.tool === "act_on_page" && state.openedOrMappedThisRound) {
    return {
      boundary: "post_open_or_map",
      reason: [
        `Deferred ${remainingStepCount} planned page-action step(s) until the next planning round because understand_page just opened or mapped the visible page.`,
        "The next plan will target the fresh actionable map instead of relying on stale plan-time page context."
      ].join(" ")
    };
  }

  return undefined;
}

function appendDeferralToLastExecutedStep(
  executed: ExecutedStep[],
  deferred: DeferredPlanSteps,
  annotate: boolean
): void {
  const last = executed.at(-1);
  if (!last) {
    return;
  }
  last.deferred = deferred;
  if (annotate) {
    last.summary = `${last.summary}\n\n${deferred.reason}`;
    last.warnings = [...last.warnings, deferred.reason];
  }
}
