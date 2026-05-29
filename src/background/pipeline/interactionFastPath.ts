/**
 * Corpus-first interaction fast-path (pipeline inversion, step 1).
 *
 * Runs BEFORE the planner for page-interaction prompts. The flow:
 *   intent gate → overlay capture → build corpus → GREP target over corpus:
 *     - EXACT (unique name match) + local scroll → FIRE (no model)
 *     - EXACT + interaction/read → ESCALATE, hint names the exact match
 *       so the model targets it by overlayIndex
 *     - SHORTLIST / NONE → ESCALATE with the candidate shortlist as the hint
 *
 * Fast-path action scope (agreed default): determinism decides WHICH element;
 * the model still authorizes actions that need page interpretation. Only local
 * scroll fires here; clicks/typing/navigation/reads escalate cheaply with hints.
 *
 * This module owns NO model calls. It is the deterministic front-half; the
 * existing planner pipeline is the escalation target.
 */

import { executeBrowserTool } from "../../tools/browserToolExecutor";
import { makeId } from "../../shared/id";
import { showActionableOverlay, type ActionableElement, type OverlayCaptureResult } from "../../tools/elementOverlay";
import type { PrefetchedBeforeObservation } from "../../tools/fat";
import {
  buildCorpus,
  renderCandidate,
  searchCorpus,
  type SearchOptions
} from "../../tools/elementCorpus";

export type FastPathAction = "read" | "click" | "type" | "select" | "press_key" | "scroll";

/** Scroll can fire with no model; reads still need a gather step to answer. */
const READ_ONLY_ACTIONS: ReadonlySet<FastPathAction> = new Set(["scroll"]);

export type FastPathIntent = {
  /** The interaction the prompt is asking for. */
  action: FastPathAction;
  /** The target phrase extracted from the prompt (the search query). */
  query: string;
  /** Target type explicitly named by the user, when it changes candidate choice. */
  targetKind?: "link";
  /** Text to type, for the "type" action. */
  text?: string;
};

export type FastPathOutcome =
  | {
      /** Fired deterministically — turn can short-circuit with this answer. */
      kind: "fired";
      answer: string;
      capture: OverlayCaptureResult;
      winner: ActionableElement;
    }
  | {
      /** Hand off to the planner; carries a corpus hint to seed it (may be empty). */
      kind: "escalate";
      reason: string;
      capture?: OverlayCaptureResult;
      /** Compact ranked candidates to inject into the planner prompt. */
      hint?: string;
      /** Before-action observe pass started while the planner authorizes. */
      prefetchedBeforeObservation?: PrefetchedBeforeObservation;
    }
  | {
      /** Not a page-interaction prompt — fast-path does not apply. */
      kind: "skip";
    };

// --- Intent gate + target extraction -----------------------------------------

const ACTION_VERBS: Array<{ re: RegExp; action: FastPathAction; strong: boolean }> = [
  { re: /\b(type|enter|input|fill(?:\s+in)?|write)\b/, action: "type", strong: true },
  { re: /\b(select|choose|pick)\b/, action: "select", strong: true },
  { re: /\b(scroll)\b/, action: "scroll", strong: true },
  { re: /\b(press|hit)\b/, action: "press_key", strong: true },
  // Strong click verbs are unambiguously page interactions.
  { re: /\b(click|tap)\b/, action: "click", strong: true },
  // Weak click-ish verbs (open/go to/navigate/follow/visit) have strong non-page
  // meanings, so they require a page/target reference to qualify.
  { re: /\b(open|go\s+to|navigate|follow|visit)\b/, action: "click", strong: false },
  { re: /\b(read|view|show|summari[sz]e|extract|tell me about)\b/, action: "read", strong: false }
];

const TARGET_NOUNS = /\b(button|link|field|input|box|tab|menu|option|checkbox|radio|dropdown|icon|toggle|item|row|card|page|site|website|form)\b/;

/**
 * Decide whether this prompt is a single-target page interaction and, if so,
 * extract the action and the target phrase (the search query). Conservative:
 * only fires for clear interaction phrasings, so non-page prompts ("3rd planet
 * from the sun") and broad research prompts fall through untouched.
 */
export function detectFastPathIntent(userMessage: string): FastPathIntent | undefined {
  const text = isolatePrimaryActionClause(userMessage.trim());
  if (!text) {
    return undefined;
  }
  const lower = text.toLowerCase();

  const matchedVerb = ACTION_VERBS.find((v) => v.re.test(lower));
  if (!matchedVerb) {
    return undefined;
  }

  // Qualification: a STRONG verb (click/tap/type/select/scroll/press) needs only
  // a residual target phrase — the grep decides if it matches a real element and
  // falls back to the model if not. WEAK verbs (open/go-to/navigate/read/view…)
  // are ambiguous with non-page requests ("read War and Peace", "open my email"),
  // so they still require a page/target reference to qualify.
  const target = TARGET_NOUNS.test(lower) || /\b(this|the|current|active|open)\s+(page|site|website|form)\b/.test(lower);
  if (!matchedVerb.strong && !target) {
    return undefined;
  }

  // Extract the target phrase (the grep query). Must be non-empty — a bare
  // "click" with nothing to target is not actionable here.
  const query = extractTargetPhrase(text, matchedVerb.action);
  if (!query) {
    return undefined;
  }
  const targetKind = inferTargetKind(text);

  const intent: FastPathIntent = { action: matchedVerb.action, query };
  if (targetKind) {
    intent.targetKind = targetKind;
  }
  if (matchedVerb.action === "type") {
    intent.text = extractTypeText(text);
  }
  return intent;
}

const TARGET_NOUN_WORDS = "button|link|field|input|box|tab|menu|option|checkbox|radio|dropdown|icon|toggle|item|row|card|page|site|website|form";
const LEADING_FILLER_WORDS = "on|in|into|onto|from|to|the|a|an|this|that|current|active|open";
const STRIP_VERBS = /\b(click|tap|press|hit|open|go\s+to|navigate|follow|visit|type|enter|input|fill(?:\s+in)?|write|select|choose|pick|scroll|read|view|show|summari[sz]e|extract|tell me about)\b/gi;

/**
 * Trim leading filler (articles/prepositions) and a trailing target noun, but
 * PRESERVE interior words — so "the sign in button" → "sign in", not "sign"
 * (stripping interior "in" would corrupt multi-word names).
 */
function cleanPhrase(raw: string): string {
  let s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  s = isolatePrimaryActionClause(s).toLowerCase();
  s = s.replace(/\s+(?:on|in|from)\s+(?:(?:the|a|an|this|that|current|active|open)\s+)*(?:page|site|website|form)\s*$/i, "");
  // Strip repeated leading filler words.
  const leading = new RegExp(`^(?:(?:${LEADING_FILLER_WORDS})\\s+)+`);
  s = s.replace(leading, "");
  // Strip a trailing target noun (and any trailing filler before it).
  const trailing = new RegExp(`(?:\\s+(?:${TARGET_NOUN_WORDS}))+\\s*$`);
  s = s.replace(trailing, "");
  // Strip leading filler again in case removing the verb exposed more.
  s = s.replace(leading, "");
  return s.trim();
}

function isolatePrimaryActionClause(text: string): string {
  return text
    .replace(/\s*(?:,|;)?\s+(?:and\s+)?then\s+(?:tell|show|describe|report|summari[sz]e|explain)\b[\s\S]*$/i, "")
    .replace(/\s*,\s*(?:and\s+)?(?:tell|show|describe|report|summari[sz]e|explain)\b[\s\S]*$/i, "")
    .replace(/\s+and\s+(?:tell\s+me|show\s+me|describe|report|summari[sz]e|explain)\b[\s\S]*$/i, "")
    .trim();
}

function inferTargetKind(text: string): FastPathIntent["targetKind"] {
  return /\blink\b/i.test(text) ? "link" : undefined;
}

function extractTargetPhrase(text: string, action: FastPathAction): string | undefined {
  // For "type X into Y", the TARGET is the field after "into" — handle this
  // FIRST, because the quoted part is the VALUE (X), not the target.
  if (action === "type") {
    const into = text.toLowerCase().match(/\b(?:into|in)\s+(?:the\s+|a\s+|an\s+)?(.+)$/);
    if (into?.[1]) {
      const field = cleanPhrase(into[1]);
      if (field) {
        return field;
      }
    }
  }

  // Quoted phrase wins for non-type actions (the quote IS the target).
  if (action !== "type") {
    const quoted = text.match(/["'“”']([^"'“”']{1,80})["'“”']/);
    if (quoted?.[1]?.trim()) {
      return quoted[1].trim();
    }
  }

  // Strip a leading action verb + filler + trailing target noun
  // ("the sign in button" → "sign in").
  const phrase = cleanPhrase(
    text.replace(/^\s*(please\s+)?(can you\s+|could you\s+)?/i, "").replace(STRIP_VERBS, "")
  );
  return phrase || undefined;
}

function extractTypeText(text: string): string | undefined {
  // "type 'foo' into ..." or "enter foo in the ...".
  const quoted = text.match(/\b(?:type|enter|input|write|fill(?:\s+in)?)\b\s+["'“”']([^"'“”']+)["'“”']/i);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const between = text.match(/\b(?:type|enter|input|write)\b\s+(.+?)\s+\b(?:into|in)\b/i);
  return between?.[1]?.trim() || undefined;
}

// --- Fast-path execution ------------------------------------------------------

export async function runInteractionFastPath(args: {
  userMessage: string;
  tabId?: number;
  /** Reuse the mandatory pre-planning overlay capture when one already exists. */
  capture?: OverlayCaptureResult;
  /**
   * Pre-built site inventory (robots/sitemap/link harvest) for the current page,
   * appended to the escalation hint so the model knows what OTHER pages exist —
   * e.g. when the target isn't on this page but is a known path. Optional.
   */
  siteReconText?: string;
  onProgress?: (label: string, detail: string) => void;
}): Promise<FastPathOutcome> {
  const intent = detectFastPathIntent(args.userMessage);
  if (!intent) {
    return { kind: "skip" };
  }

  // Overlay FIRST.
  let capture: OverlayCaptureResult;
  try {
    capture = args.capture ?? await showActionableOverlay(args.tabId);
  } catch (error) {
    // Capture failed (e.g. unsupported page) — let the planner handle it.
    return { kind: "escalate", reason: `overlay capture failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const corpus = buildCorpus(capture);
  const searchOptions: SearchOptions = intent.targetKind === "link"
    ? {
        requireLink: true,
        currentUrl: capture.url,
        preferNonCurrentUrl: isGenericNavigationTarget(intent.query)
      }
    : {};
  const result = searchCorpus(intent.query, corpus, searchOptions);

  // Build the hint for the model: the exact match named first, else the shortlist,
  // plus the site inventory (other known pages) when available.
  const shortlist =
    result.kind === "exact" ? [result.winner] : result.kind === "shortlist" ? result.candidates : [];
  const hintParts: string[] = [];
  hintParts.push(`Current page before planning: ${capture.title || "(untitled)"} — ${capture.url}`);
  if (intent.targetKind === "link") {
    hintParts.push(
      isGenericNavigationTarget(intent.query)
        ? "Target constraint: the user asked for a real navigation link. Choose only link elements with a destination URL, and prefer a destination different from the current page URL; do not choose generic buttons, menus, or current-page self-links."
        : "Target constraint: the user asked for a real link/navigation destination. Choose only link elements or elements with a destination URL; do not choose generic buttons or menus."
    );
  }
  if (shortlist.length) {
    const listName = intent.targetKind === "link" ? "Actionable link elements" : "Actionable elements";
    hintParts.push(`${listName} matching "${intent.query}" (choose the right one by overlayIndex):\n${shortlist.map((candidate) => renderCandidate(candidate, { currentUrl: capture.url })).join("\n")}`);
  }
  if (args.siteReconText) {
    hintParts.push(args.siteReconText);
  }
  const hint = hintParts.length ? hintParts.join("\n\n") : undefined;

  args.onProgress?.("Interaction", `Grep "${intent.query}" → ${result.kind}${result.kind === "exact" ? ` #${result.winner.index}` : ""}`);

  // EXACT + read-only → FIRE deterministically (no model).
  if (result.kind === "exact" && READ_ONLY_ACTIONS.has(intent.action)) {
    const fired = await fireReadOnly(intent, result.winner, args.tabId);
    return { kind: "fired", answer: fired, capture, winner: result.winner };
  }

  const shouldPrefetchBeforeObservation = intent.action !== "read" && !READ_ONLY_ACTIONS.has(intent.action);

  // EXACT + interaction/read → escalate; the hint names the single exact match
  // so the planner targets that overlayIndex or opens the matched link.
  if (result.kind === "exact") {
    return {
      kind: "escalate",
      reason: intent.action === "read"
        ? `exact match #${result.winner.index} ("${result.winner.accessibleName}") for a read — planner should gather the linked/current page content`
        : `exact match #${result.winner.index} ("${result.winner.accessibleName}") for a ${intent.action} — action is model-authorized`,
      capture,
      hint,
      prefetchedBeforeObservation: shouldPrefetchBeforeObservation ? startBeforeObservationPrefetch(args.tabId) : undefined
    };
  }

  // SHORTLIST / NONE → escalate; the model picks from the shortlist.
  return {
    kind: "escalate",
    reason: result.kind === "shortlist"
      ? `no unique exact match for "${intent.query}" — ${shortlist.length} candidate(s) for the model`
      : `no element matched "${intent.query}"`,
    capture,
    hint,
    prefetchedBeforeObservation: shouldPrefetchBeforeObservation ? startBeforeObservationPrefetch(args.tabId) : undefined
  };
}

function startBeforeObservationPrefetch(tabId?: number): PrefetchedBeforeObservation {
  const tabArg = tabId !== undefined ? { tabId } : {};
  const promise = executeBrowserTool({ id: makeId("act-prefetch"), name: "browser_observe_page", input: { ...tabArg } });
  void promise.catch(() => undefined);
  return {
    startedAtMs: Date.now(),
    promise
  };
}

export function isGenericNavigationTarget(query: string): boolean {
  return /^(nav|navigation|link|page|another page|different page)$/i.test(query.trim());
}

async function fireReadOnly(intent: FastPathIntent, winner: ActionableElement, tabId?: number): Promise<string> {
  const tabArg = tabId !== undefined ? { tabId } : {};
  if (intent.action === "scroll") {
    await executeBrowserTool(
      { id: makeId("fp"), name: "browser_scroll_page", input: { ...tabArg, target: { overlayIndex: winner.index } } },
      { allowPageActions: true }
    );
    return `Scrolled to ${describeWinner(winner)}.`;
  }
  // "read": observe/describe the chosen element rather than mutate.
  return `The best match for your request is ${describeWinner(winner)} (overlay index #${winner.index}).`;
}

function describeWinner(el: ActionableElement): string {
  const name = el.accessibleName ? `"${el.accessibleName}"` : `the ${el.role ?? el.tagName}`;
  return `${name}${el.link ? ` (→ ${el.link.path})` : ""}`;
}
