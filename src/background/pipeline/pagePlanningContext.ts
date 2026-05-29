/**
 * Pre-planning page corpus.
 *
 * This is the deterministic "map first" pass that runs before the planner sees
 * the prompt. It paints/captures the actionable overlay, builds a compact corpus,
 * searches that corpus with the user's natural-language target, and emits a
 * small draft workflow the planner can validate/repair instead of planning
 * blind.
 */

import {
  buildCorpus,
  renderCandidate,
  searchCorpus,
  type SearchOptions
} from "../../tools/elementCorpus";
import {
  showActionableOverlay,
  type ActionableElement,
  type OverlayCaptureResult
} from "../../tools/elementOverlay";
import {
  detectFastPathIntent,
  isGenericNavigationTarget,
  type FastPathIntent
} from "./interactionFastPath";
import type { PlanStep } from "./planner";

export type PagePlanningContext = {
  capture: OverlayCaptureResult;
  /** Prompt-ready natural-language packet for the planner. */
  plannerText: string;
  /** Deterministic draft steps, when the corpus has a safe workflow scaffold. */
  draftSteps: PlanStep[];
  /** Short log/activity summary. */
  logSummary: string;
};

export async function buildPagePlanningContext(args: {
  userMessage: string;
  tabId?: number;
  capture?: OverlayCaptureResult;
}): Promise<PagePlanningContext | undefined> {
  let capture: OverlayCaptureResult;
  try {
    capture = args.capture ?? await showActionableOverlay(args.tabId);
  } catch {
    return undefined;
  }
  return createPagePlanningContext({
    userMessage: args.userMessage,
    capture
  });
}

export function createPagePlanningContext(args: {
  userMessage: string;
  capture: OverlayCaptureResult;
}): PagePlanningContext {
  const corpus = buildCorpus(args.capture);
  const intent = detectFastPathIntent(args.userMessage);
  const searchOptions = intent ? searchOptionsForIntent(intent, args.capture.url) : {};
  const search = intent ? searchCorpus(intent.query, corpus, searchOptions) : undefined;
  const targetCandidates =
    search?.kind === "exact" ? [search.winner] :
      search?.kind === "shortlist" ? search.candidates :
        [];
  const draft = buildDraftWorkflow({
    userMessage: args.userMessage,
    intent,
    search,
    capture: args.capture
  });
  const counts = countActionables(args.capture.elements);
  const representativeLinks = selectRepresentativeLinks(args.capture.elements, args.capture.url, 8);
  const representativeActions = args.capture.elements.slice(0, 10);

  const plannerText = [
    "Pre-planning page corpus from deterministic overlay.",
    `Page: ${args.capture.title || "(untitled)"} — ${args.capture.url}`,
    `Actionable inventory: ${args.capture.elements.length} element(s); links ${counts.links}, buttons ${counts.buttons}, fields ${counts.fields}, menus/options ${counts.menus}, other ${counts.other}.`,
    args.capture.warnings.length ? `Overlay warnings: ${args.capture.warnings.slice(0, 3).join("; ")}` : "",
    intent
      ? [
          "Parsed user/page intent:",
          `- action: ${intent.action}`,
          `- target query: "${intent.query}"`,
          intent.targetKind ? `- target kind: ${intent.targetKind}` : "",
          targetCandidates.length
            ? `Target candidates from page corpus:\n${targetCandidates.map((candidate) => renderCandidate(candidate, { currentUrl: args.capture.url })).join("\n")}`
            : `Target candidates from page corpus: ${search?.kind ?? "none"}`
        ].filter(Boolean).join("\n")
      : "Parsed user/page intent: no specific page action target detected.",
    representativeLinks.length
      ? `Representative navigation links:\n${representativeLinks.map((candidate) => renderCandidate(candidate, { currentUrl: args.capture.url })).join("\n")}`
      : "",
    representativeActions.length
      ? `Representative actionables:\n${representativeActions.map((candidate) => renderCandidate(candidate, { currentUrl: args.capture.url })).join("\n")}`
      : "",
    draft.description,
    "Planner instruction: validate this packet against the user prompt. If the draft workflow matches the request, copy/repair it into the JSON plan. If the target is ambiguous, use the candidate list instead of inventing a selector; only ask for more model help after deterministic execution cannot safely complete a provided step."
  ].filter(Boolean).join("\n\n");

  return {
    capture: args.capture,
    plannerText,
    draftSteps: draft.steps,
    logSummary: `${args.capture.elements.length} actionable element(s) mapped${draft.steps.length ? `; draft ${draft.steps.map((step) => step.tool).join(" → ")}` : ""}.`
  };
}

function searchOptionsForIntent(intent: FastPathIntent, currentUrl: string): SearchOptions {
  if (intent.targetKind !== "link") {
    return {};
  }
  return {
    requireLink: true,
    currentUrl,
    preferNonCurrentUrl: isGenericNavigationTarget(intent.query)
  };
}

function buildDraftWorkflow(args: {
  userMessage: string;
  intent: FastPathIntent | undefined;
  search: ReturnType<typeof searchCorpus> | undefined;
  capture: OverlayCaptureResult;
}): { steps: PlanStep[]; description: string } {
  const steps: PlanStep[] = [];
  const notes: string[] = [];

  if (!args.intent) {
    if (looksLikeCurrentPageRead(args.userMessage)) {
      steps.push({ tool: "understand_page", args: {}, rationale: "Read the current page because the prompt asks about this page." });
      notes.push("Draft workflow: understand_page {}");
    } else {
      notes.push("Draft workflow: none. The prompt did not resolve to a safe page-action workflow.");
    }
    return { steps, description: notes.join("\n") };
  }

  const chosen = chooseDraftTarget(args.intent, args.search, args.capture.url);
  if (args.intent.action === "read" && chosen?.link?.href) {
    steps.push({
      tool: "understand_page",
      args: { url: chosen.link.href },
      rationale: `Open and read the matched link "${chosen.accessibleName ?? chosen.link.path}".`
    });
    notes.push(`Draft workflow: understand_page {"url":"${chosen.link.href}"}`);
    notes.push(`Draft confidence: ${args.search?.kind === "exact" ? "high exact link match" : "medium selected navigation candidate"}.`);
    return { steps, description: notes.join("\n") };
  }

  const action = chosen ? actionStepForIntent(args.intent, chosen) : undefined;
  if (action) {
    steps.push({
      tool: "act_on_page",
      args: { steps: [action] },
      rationale: `Use overlay index #${chosen?.index} from the deterministic page corpus.`
    });
    if (asksForPostActionPageReport(args.userMessage)) {
      steps.push({
        tool: "understand_page",
        args: {},
        rationale: "Read the resulting page/state so the final answer can report what changed."
      });
    }
    notes.push(`Draft workflow JSON steps:\n${JSON.stringify(steps, null, 2)}`);
    notes.push(`Draft confidence: ${args.search?.kind === "exact" ? "high exact element match" : "medium deterministic generic-link choice"}.`);
    return { steps, description: notes.join("\n") };
  }

  if (args.search?.kind === "shortlist") {
    notes.push("Draft workflow: target shortlist only. The model should choose among the listed candidates if the prompt allows a representative target; otherwise ask for/derive a more specific target.");
  } else {
    notes.push("Draft workflow: none. No safe target was found in the current page corpus.");
  }
  return { steps, description: notes.join("\n") };
}

function chooseDraftTarget(
  intent: FastPathIntent,
  search: ReturnType<typeof searchCorpus> | undefined,
  currentUrl: string
): ActionableElement | undefined {
  if (!search) {
    return undefined;
  }
  if (search.kind === "exact") {
    return search.winner;
  }
  if (search.kind !== "shortlist") {
    return undefined;
  }
  if (intent.action === "click" && intent.targetKind === "link" && isGenericNavigationTarget(intent.query)) {
    return chooseGenericNavigationCandidate(search.candidates, currentUrl);
  }
  return undefined;
}

function chooseGenericNavigationCandidate(candidates: ActionableElement[], currentUrl: string): ActionableElement | undefined {
  return candidates
    .filter((candidate) => isUsableNavigationLink(candidate, currentUrl))
    .map((candidate, order) => ({ candidate, order, score: scoreNavigationCandidate(candidate) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)[0]?.candidate;
}

function actionStepForIntent(intent: FastPathIntent, target: ActionableElement): Record<string, unknown> | undefined {
  if (intent.action === "click" || intent.action === "scroll") {
    return { action: intent.action, target: { overlayIndex: target.index } };
  }
  if (intent.action === "type" && intent.text) {
    return { action: "type", target: { overlayIndex: target.index }, text: intent.text };
  }
  return undefined;
}

function countActionables(elements: ActionableElement[]): {
  links: number;
  buttons: number;
  fields: number;
  menus: number;
  other: number;
} {
  let links = 0;
  let buttons = 0;
  let fields = 0;
  let menus = 0;
  let other = 0;
  for (const element of elements) {
    const role = element.role ?? "";
    if (element.link || role === "link" || element.tagName.toLowerCase() === "a") {
      links += 1;
    } else if (role === "button" || element.tagName.toLowerCase() === "button") {
      buttons += 1;
    } else if (["textbox", "combobox", "searchbox"].includes(role) || ["input", "textarea", "select"].includes(element.tagName.toLowerCase())) {
      fields += 1;
    } else if (["menu", "menuitem", "option", "tab"].includes(role)) {
      menus += 1;
    } else {
      other += 1;
    }
  }
  return { links, buttons, fields, menus, other };
}

function selectRepresentativeLinks(elements: ActionableElement[], currentUrl: string, limit: number): ActionableElement[] {
  return elements
    .filter((element) => isUsableNavigationLink(element, currentUrl))
    .map((candidate, order) => ({ candidate, order, score: scoreNavigationCandidate(candidate) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.candidate);
}

function isUsableNavigationLink(element: ActionableElement, currentUrl: string): boolean {
  if (!element.link?.href || !element.isEnabled || !element.isVisible) {
    return false;
  }
  if (element.link.kind !== "navigation" && element.link.kind !== "external") {
    return false;
  }
  return comparableUrl(element.link.href) !== comparableUrl(currentUrl);
}

function scoreNavigationCandidate(element: ActionableElement): number {
  const name = (element.accessibleName ?? "").toLowerCase().trim();
  const path = element.link?.path ?? "";
  let score = 0;
  if (element.link?.kind === "navigation") {
    score += 8;
  }
  if (element.link?.rel === "same-origin" || element.link?.rel === "same-site") {
    score += 4;
  }
  if (path && path !== "/" && path !== "/#") {
    score += 3;
  }
  if (name.length >= 3) {
    score += 1;
  }
  if (/^(skip to content|skip|home|homepage|logo)$/i.test(name)) {
    score -= 8;
  }
  if (element.link?.target === "_blank") {
    score -= 1;
  }
  return score;
}

function looksLikeCurrentPageRead(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(?:what is|what's|summari[sz]e|read|understand|describe|inspect|analy[sz]e)\b/.test(text) &&
    /\b(?:this|current|active|open)\s+(?:page|site|website|tab)\b/.test(text);
}

function asksForPostActionPageReport(userMessage: string): boolean {
  const text = userMessage.toLowerCase().replace(/\s+/g, " ");
  const asksAfterAction = /\b(?:then|and)\b.+\b(?:tell|show|describe|report|summari[sz]e|explain)\b/.test(text);
  const asksForChange = /\b(?:what changed|what has changed|what happens?|what happened|result|changed|new page|current page|where (?:we|it) (?:are|landed)|now visible)\b/.test(text);
  const action = /\b(?:click|tap|open|go to|navigate|follow|visit|select|choose|press|submit)\b/.test(text);
  return action && asksAfterAction && asksForChange;
}

function comparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.replace(/#.*$/, "").replace(/\/$/, "");
  }
}
