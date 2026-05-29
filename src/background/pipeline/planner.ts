/**
 * The PLAN step — a pure-from-scratch model planner.
 *
 * Given the user's prompt (and, on later loop iterations, the accumulated
 * summary + what's still missing), the selected model emits a STRICT JSON plan:
 * an ordered list of fat-tool steps to run deterministically. The plan is then
 * validated against the fat-tool cards so it can neither name a tool that does
 * not exist nor omit required args. Invalid steps are dropped; an empty/garbage
 * plan surfaces as a parse failure the caller handles.
 *
 * The model is used ONLY to choose tools + fill args here. It does not execute
 * anything and never sees raw tool output — only the prompt + prior summaries.
 */

import {
  callAnthropicMessage,
  extractText,
  type AnthropicMessageParam
} from "../../model/anthropicToolClient";
import type { AppSettings } from "../../settings/settingsStore";
import { cardForTool, renderCardsForPrompt } from "./fatToolCards";
import { renderHistory } from "./conversationHistory";
import type { FatToolName } from "../../tools/fat/fatToolTypes";
import type { ChatContextMessage } from "../../conversation/conversationTypes";
import { describeActiveSource, type ActiveWorkingFileDescriptor } from "../../filecorpus/corpusTypes";

export type CurrentPageContext = {
  tabId?: number;
  title?: string;
  url?: string;
  status?: string;
};

export type PlanStep = {
  tool: FatToolName | "grep_extractions";
  args: Record<string, unknown>;
  rationale?: string;
};

export type Plan = {
  steps: PlanStep[];
  /** Model's stated reason for this plan (for logs/UI). */
  reason: string;
};

export type PlanResult = {
  plan: Plan;
  warnings: string[];
  /** Raw model text, for debugging/logs. */
  raw: string;
};

/** A previously-executed step, used to force re-plans to vary. */
export type PriorAttempt = {
  tool: string;
  args: Record<string, unknown>;
  /** Compact result the step returned (used to detect unchanged repeats). */
  summary: string;
};

/** Stable key for a (tool, args) pair so identical steps compare equal. */
export function attemptKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}::${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Deterministic no-progress backstop: drop any planned step whose (tool, args)
 * exactly matches a prior attempt that returned the SAME summary. Such a step
 * is guaranteed to produce the identical result, so re-running it only wastes an
 * iteration. Steps that vary args, or whose prior result differed, are kept.
 * Pure + unit-testable.
 */
export function dropNoProgressSteps(
  steps: PlanStep[],
  priorAttempts: PriorAttempt[]
): { steps: PlanStep[]; warnings: string[] } {
  if (!priorAttempts.length) {
    return { steps, warnings: [] };
  }
  const seen = new Map<string, string>();
  for (const attempt of priorAttempts) {
    seen.set(attemptKey(attempt.tool, attempt.args), attempt.summary);
  }
  const kept: PlanStep[] = [];
  const warnings: string[] = [];
  for (const step of steps) {
    const key = attemptKey(step.tool, step.args);
    if (seen.has(key)) {
      warnings.push(`Dropped a re-planned ${step.tool} step that repeats an earlier identical attempt (same tool and args); it would return the same result.`);
      continue;
    }
    kept.push(step);
  }
  return { steps: kept, warnings };
}

const PLANNER_SYSTEM_PROMPT = [
  "You are the deterministic-plan builder for a Chrome assistant.",
  "You do NOT answer the user and you do NOT call tools yourself.",
  "You output a JSON plan: an ordered list of deterministic tool steps that will be executed without you, after which you receive only a compact summary.",
  "Pick the fewest steps that gather everything needed to fully answer the user. Gathering is cheap, so prefer one good gather step over many narrow ones.",
  "Only use tools from the provided list. Fill every required arg. Do not invent tools or args.",
  "There is also a special step `grep_extractions` (args: {query: string, tool?: string}) that searches data already gathered earlier in THIS task — use it on later iterations when the needed detail was probably already captured, instead of re-gathering.",
  "When a working file is attached and a prior `query_file` step did not surface enough to answer, re-plan a `query_file` step with broaden=\"true\" and/or different query terms — do NOT repeat the identical query.",
  "When prior conversation turns are provided, interpret the user's prompt IN THAT CONTEXT: a follow-up like 'now do the same for X', 'go deeper on that', or 'what about the second one' refers to the earlier turns. Resolve such references before planning, and plan for the resolved intent.",
  "Master planning template: (1) classify the task type, (2) resolve the user's concrete goal and success criteria, (3) inspect the current tab/page packet and any attached/captured context, (4) draft the full likely workflow from start to finish, (5) include the evidence-gathering step that proves the final answer, and (6) omit only steps that are genuinely impossible to specify before execution.",
  "When a pre-planning page corpus/draft workflow is provided, treat it as the deterministic first-pass map of the current page. Validate it against the user's words; if it matches, copy or minimally repair its JSON steps instead of inventing targets from memory.",
  "For visible-page workflows, plan the whole likely step-by-step workflow the user asked for, even across page-state boundaries. Example: if the user asks to click a navigation link and tell what changed, include both `act_on_page` and the follow-up `understand_page` in the same plan. The executor will pause/resume safely at page-state boundaries; only omit later steps when they are genuinely ambiguous until after the current step runs.",
  "CRITICAL — when re-planning: you are given the steps already attempted and what each returned. A re-plan MUST be a genuine VARIATION that targets what is still missing — a different tool, different args, a different decomposition, or a targeted grep over what was already gathered. NEVER repeat a step with the same tool AND the same args as one already attempted; that returns the identical result and wastes an iteration. If the only way to get the missing data is a step that already failed for a reason that cannot change (e.g. a capability is unavailable), do NOT re-issue it — return an empty steps array so the assistant answers with what it has and states the limitation.",
  "Return ONLY JSON in this shape: {\"reason\":\"...\",\"steps\":[{\"tool\":\"understand_page\",\"args\":{},\"rationale\":\"...\"}]}"
].join("\n");

const VALID_TOOLS = new Set<string>([
  "understand_page",
  "capture_network",
  "inspect_runtime",
  "search_web",
  "read_workspace",
  "query_file",
  "act_on_page",
  "write_workspace",
  "grep_extractions"
]);

export async function buildPlan(args: {
  settings: AppSettings;
  userMessage: string;
  /** Prior conversation turns so follow-ups are planned in context. */
  history?: ChatContextMessage[];
  accumulatedSummary?: string;
  missing?: string;
  /** Steps already attempted this task — forces re-plans to vary. */
  priorAttempts?: PriorAttempt[];
  /**
   * A pre-ranked actionable map for the current page, produced by the
   * interaction fast-path. When present, the model should target by overlayIndex
   * from this ranked list rather than guessing by text — it has already SEEN the
   * map, so its first plan is informed, not blind.
   */
  actionableHint?: string;
  /** Deterministic page corpus + draft workflow built before the planner call. */
  pagePlanningContext?: string;
  /** Cached site inventory for the current origin/page, when available. */
  siteReconText?: string;
  /** Current visible tab before planning; lets the planner avoid redundant self-navigation. */
  currentPageContext?: CurrentPageContext;
  /** Structured captured UI context from the side panel, when present. */
  activeCaptureContext?: string;
  /** When set, a working file is attached — the planner should query_file. */
  activeWorkingFile?: ActiveWorkingFileDescriptor;
  model?: string;
  signal?: AbortSignal;
}): Promise<PlanResult> {
  const priorAttempts = args.priorAttempts ?? [];
  const historyText = renderHistory(args.history);
  const workingFile = args.activeWorkingFile;
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
      `User prompt:\n${args.userMessage}`,
      args.currentPageContext
        ? `\nCurrent browser tab before planning:\n${renderCurrentPageContext(args.currentPageContext)}\nUse this page state when choosing browser actions. If the user asks to click a navigation link or report what changed, avoid choosing a link whose destination is already the current URL unless the user explicitly named that current/self link.`
        : "",
      args.activeCaptureContext
        ? `\nActive captured UI context supplied by the user:\n${args.activeCaptureContext}`
        : "",
      args.pagePlanningContext
        ? `\nPre-planning page corpus and deterministic draft workflow:\n${args.pagePlanningContext}`
        : "",
      args.siteReconText
        ? `\nCached site map for the current origin/page:\n${args.siteReconText}`
        : "",
      workingFile
        ? `\nAttached source available: ${describeActiveSource(workingFile)}. Use \`query_file\` when the user's request is about source/file/folder/code/document contents or explicitly refers to the attached source. Ignore this source for browser-only page interaction/navigation tasks.`
        : "",
      args.actionableHint ? `\nThe page's actionable elements, ranked for this prompt (target the right one by overlayIndex):\n${args.actionableHint}` : "",
      args.accumulatedSummary ? `\nWhat we have gathered so far (summaries):\n${args.accumulatedSummary}` : "",
      args.missing ? `\nWhat is still missing to fully answer:\n${args.missing}` : "",
      priorAttempts.length ? `\nSteps already attempted this task (do NOT repeat any of these with the same args — vary your approach):\n${renderAttempts(priorAttempts)}` : "",
      "",
      "Available tools:",
      renderCardsForPrompt(),
      "",
      "Output the JSON plan now."
    ].filter(Boolean).join("\n")
  }];

  const response = await callAnthropicMessage({
    settings: args.settings,
    model: args.model,
    system: PLANNER_SYSTEM_PROMPT,
    messages,
    signal: args.signal
  });
  const raw = extractText(response.content);
  const parsed = parsePlan(raw);

  // Deterministic backstop: even if the model ignores the instruction, never
  // re-run a step identical to a prior attempt that returned the same result.
  const backstop = dropNoProgressSteps(parsed.plan.steps, priorAttempts);
  return {
    plan: { steps: backstop.steps, reason: parsed.plan.reason },
    warnings: [...parsed.warnings, ...backstop.warnings],
    raw
  };
}

export function renderCurrentPageContext(context: CurrentPageContext): string {
  return [
    context.tabId !== undefined ? `tabId: ${context.tabId}` : undefined,
    context.title ? `title: ${context.title}` : undefined,
    context.url ? `url: ${context.url}` : undefined,
    context.status ? `status: ${context.status}` : undefined
  ].filter((part): part is string => Boolean(part)).join("\n");
}

function renderAttempts(attempts: PriorAttempt[]): string {
  return attempts
    .map((attempt, index) => {
      const args = stableStringify(attempt.args);
      const result = attempt.summary.slice(0, 200).replace(/\s+/g, " ").trim();
      return `${index + 1}. ${attempt.tool} ${args} → ${result || "(no result)"}`;
    })
    .join("\n");
}

/** Parse + validate a planner response into a Plan. Pure; unit-testable. */
export function parsePlan(raw: string): PlanResult {
  const warnings: string[] = [];
  const parsed = tolerantJsonObject(raw);
  if (!parsed) {
    return { plan: { steps: [], reason: "" }, warnings: ["Planner did not return valid JSON."], raw };
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps: PlanStep[] = [];

  for (let i = 0; i < rawSteps.length; i += 1) {
    const step = rawSteps[i];
    if (typeof step !== "object" || step === null) {
      warnings.push(`Step ${i + 1} was not an object; skipped.`);
      continue;
    }
    const s = step as Record<string, unknown>;
    const tool = typeof s.tool === "string" ? s.tool : "";
    if (!VALID_TOOLS.has(tool)) {
      warnings.push(`Step ${i + 1} used unknown tool "${tool}"; skipped.`);
      continue;
    }
    const argsObj = typeof s.args === "object" && s.args !== null ? (s.args as Record<string, unknown>) : {};

    const missingArg = validateArgs(tool, argsObj);
    if (missingArg) {
      warnings.push(`Step ${i + 1} (${tool}) is missing required arg "${missingArg}"; skipped.`);
      continue;
    }

    steps.push({
      tool: tool as PlanStep["tool"],
      args: argsObj,
      rationale: typeof s.rationale === "string" ? s.rationale : undefined
    });
  }

  return { plan: { steps, reason }, warnings, raw };
}

function validateArgs(tool: string, argsObj: Record<string, unknown>): string | undefined {
  if (tool === "grep_extractions") {
    return typeof argsObj.query === "string" && argsObj.query.trim() ? undefined : "query";
  }
  const card = cardForTool(tool);
  if (!card) {
    return undefined;
  }
  for (const arg of card.args) {
    if (!arg.required) {
      continue;
    }
    const value = argsObj[arg.name];
    const present = arg.type === "string"
      ? typeof value === "string" && value.trim().length > 0
      : arg.type === "number"
        ? typeof value === "number"
        : Array.isArray(value) && value.length > 0;
    if (!present) {
      return arg.name;
    }
  }
  return undefined;
}

function tolerantJsonObject(text: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(s) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  return tryParse(text.trim()) ?? (() => {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? tryParse(match[0]) : undefined;
  })();
}
