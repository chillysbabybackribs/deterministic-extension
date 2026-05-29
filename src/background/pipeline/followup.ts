/**
 * The FOLLOW-UP step — runs AFTER the answer, deciding whether to add anything.
 *
 * The main answer streams first and stands on its own. This step is a separate,
 * lightweight model call that looks at (the conversation + the answer just given
 * + what the assistant can actually do) and chooses ONE of:
 *
 *   - none:       say nothing further. THIS IS THE DEFAULT and the common case.
 *   - proceed:    there is a clear, low-cost, low-risk next step the user
 *                 obviously wants — so instead of ASKING, just DO it: the text is
 *                 a directive the pipeline runs inline and folds into the same
 *                 response. Used when continuing is plainly more useful than
 *                 stopping to ask (and not risky/expensive/ambiguous).
 *   - suggestion: a specific, non-obvious next step worth OFFERING but not worth
 *                 assuming — because it mutates/navigates, is expensive, or is
 *                 genuinely optional. Offer it and stop.
 *   - probe:      one sharp question about the user's underlying goal, used only
 *                 when their motive is genuinely unclear AND knowing it would
 *                 change what help is useful. The answer is never withheld for
 *                 it — the probe is additive.
 *
 * The discipline ("not always") lives entirely in the prompt: the value is in
 * staying silent unless there is something genuinely useful to add. It is
 * generalized — it reasons from the conversation and the capability list, and is
 * hardcoded to no domain.
 */

import {
  callAnthropicMessage,
  extractText,
  type AnthropicMessageParam
} from "../../model/anthropicToolClient";
import type { AppSettings } from "../../settings/settingsStore";
import type { ChatContextMessage } from "../../conversation/conversationTypes";
import { renderHistory } from "./conversationHistory";
import { renderCapabilitiesBrief } from "./fatToolCards";

export type FollowupKind = "none" | "proceed" | "suggestion" | "probe";

export type FollowupResult = {
  kind: FollowupKind;
  /**
   * For suggestion/probe: the line shown to the user. For proceed: a directive
   * describing the next step to run inline (fed back into the planner as the new
   * intent). Empty when kind is none.
   */
  text: string;
  raw: string;
};

const EMPTY: Omit<FollowupResult, "raw"> = { kind: "none", text: "" };

const FOLLOWUP_SYSTEM_PROMPT = [
  "You decide what a Chrome assistant should do AFTER its answer: nothing, just keep going, offer a next step, or ask a question. The answer is already written and shown; you never rewrite or repeat it.",
  "Your default and most common output is NONE — add nothing. Choose anything else only when it is genuinely, specifically useful.",
  "",
  "THE CORE TEST: any next step must come from the USER'S likely GOAL, not from which tools are still unused. Ask 'what would this person most plausibly want next, and would it genuinely help?' — NOT 'what tool haven't I run yet?'. If your reason is essentially 'there's another tool available', choose NONE.",
  "",
  "PROCEED vs SUGGESTION — the key distinction:",
  "- If a clearly-wanted next step is LOW-COST, LOW-RISK, and UNAMBIGUOUS, do NOT ask — just DO it. Output 'proceed' with a directive describing the step; the system will run it and fold the result into this same answer. Stopping to ask for an obvious, safe next step wastes the user's time.",
  "- If the next step MUTATES or NAVIGATES the page, is expensive, could go wrong, or is genuinely optional/a matter of preference, OFFER it instead ('suggestion') and let the user decide.",
  "- When in doubt about cost/risk/intent, prefer suggestion over proceed; prefer none over a weak suggestion.",
  "",
  "Choose exactly one:",
  "- none: nothing worth adding. The default. Use whenever the answer is complete and no high-value, safe, obvious next step or genuine ambiguity stands out.",
  "- proceed: a clearly-wanted, low-cost, low-risk, unambiguous next step. The text is a SHORT DIRECTIVE for the system (not shown verbatim to the user) — e.g. 'Capture the network traffic on this page and summarize the API endpoints.' Write it as a self-contained instruction, since it becomes the next intent.",
  "- suggestion: a specific, valuable next step worth OFFERING but not assuming (it mutates/navigates, is expensive, or is optional). Phrase as a brief first-person OFFER — 'I can…' or 'Want me to…' — naming the concrete action and what the user GETS. One sentence. Never a bare imperative.",
  "- probe: the user's underlying GOAL is genuinely unclear AND knowing it would change what help is useful. ONE short, sharp question about their goal — not a menu. If the request was clear, do not probe.",
  "",
  "Hard rules:",
  "- Bias to none. A weak or generic suggestion is worse than silence.",
  "- Any next step must reflect what the capability ACTUALLY returns; never overpromise. Reading the console returns only JavaScript errors/warnings — it does NOT reveal how a page loads data, what APIs it calls, or how it authenticates. Capturing network returns request metadata (bodies only where the page's CSP allows). If a step wouldn't deliver what you'd be implying, do not choose it.",
  "- Do NOT proceed-with or suggest a step just because a tool is unused. 'Inspect the console to find API calls / auth / how it loads data' is forbidden — the console cannot show that.",
  "- Do NOT proceed-with or suggest re-running what was already done this turn, or chasing data the answer already said is terminally unavailable. If an earlier step already produced no new result, do not repeat it.",
  "- Never restate/summarize the answer; never thank or add pleasantries; never a reflexive 'let me know if you need anything else'.",
  "- At most ONE thing.",
  "",
  "Examples of the judgment:",
  "- After summarizing a page's purpose, nothing specific clearly needed next → none.",
  "- After capturing network whose response bodies were CSP-blocked → none (the console can't recover that; don't suggest it).",
  "- User asks 'what APIs does this page call?' and the answer described the page but no capture has run yet → proceed: 'Capture this page's network traffic and summarize the API endpoints it calls.' (cheap, safe, obviously what they want).",
  "- After mapping one dashboard page, other pages clearly merit the same treatment but it means navigating the site → suggestion: 'I can run the same breakdown on the billing and API-keys pages — want me to?' (navigation = offer, don't assume).",
  "",
  "Return ONLY JSON: {\"kind\":\"none|proceed|suggestion|probe\",\"text\":\"<directive for proceed; the line to show for suggestion/probe; empty for none>\"}"
].join("\n");

export async function runFollowup(args: {
  settings: AppSettings;
  userMessage: string;
  history?: ChatContextMessage[];
  answer: string;
  /** Compact findings the answer was built from — context for a good suggestion. */
  accumulator?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<FollowupResult> {
  // No answer to build on, or nothing was actually produced — never speak.
  if (!args.answer.trim()) {
    return { ...EMPTY, raw: "" };
  }

  const historyText = renderHistory(args.history);
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
      `The user just asked:\n${args.userMessage}`,
      "",
      `The assistant answered:\n${args.answer}`,
      args.accumulator ? `\nUnderlying findings the answer drew on (for grounding a suggestion):\n${clip(args.accumulator, 2_000)}` : "",
      "",
      "What the assistant is able to do next (its capabilities):",
      renderCapabilitiesBrief(),
      "",
      "Decide whether to add a suggestion, a probe, or nothing. Output the JSON now."
    ].filter(Boolean).join("\n")
  }];

  const response = await callAnthropicMessage({
    settings: args.settings,
    model: args.model,
    system: FOLLOWUP_SYSTEM_PROMPT,
    messages,
    signal: args.signal
  });
  return parseFollowup(extractText(response.content));
}

/**
 * Parse the follow-up decision. Pure + unit-testable. Anything unparseable, or a
 * non-none kind with empty text, collapses to none — the safe default is to add
 * nothing rather than emit garbage after a good answer.
 */
export function parseFollowup(raw: string): FollowupResult {
  const parsed = tolerantJsonObject(raw);
  if (!parsed) {
    return { ...EMPTY, raw };
  }
  const kind: FollowupKind =
    parsed.kind === "proceed" ? "proceed"
      : parsed.kind === "suggestion" ? "suggestion"
        : parsed.kind === "probe" ? "probe"
          : "none";
  if (kind === "none") {
    return { ...EMPTY, raw };
  }
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    // proceed/suggestion/probe with no text is meaningless — do nothing.
    return { ...EMPTY, raw };
  }
  return { kind, text, raw };
}

// --- Capability-gap explainer -------------------------------------------------
// Post-answer, prompt-specific explanation of why THIS task was limited and what
// the opt-in local engine would unlock for it. Generated only when a turn hit a
// capability gap; shown in the opt-in pill's details. Kept short and concrete —
// tied to the actual task, not boilerplate.

const EXPLAINER_SYSTEM_PROMPT = [
  "You write a SHORT, specific explanation for a pill offering an optional local 'background engine' that unlocks capabilities the Chrome extension can't do alone.",
  "You are given: the user's request, the answer just produced, and the concrete limitation that was hit.",
  "Write 1-2 plain sentences that (a) say specifically why THIS task was limited, and (b) say what installing the engine would let the assistant do for a task like this. Be concrete and tied to what the user was actually doing — not generic marketing.",
  "Do not restate the whole answer, do not oversell, do not promise anything the engine can't do. No preamble, no 'Note:' — just the explanation.",
  "Plain prose only, no JSON, no markdown headers."
].join("\n");

/**
 * Generate the prompt-specific explainer for a capability gap. Best-effort: on
 * any failure returns empty, and the pill falls back to its generic copy.
 */
export async function runCapabilityExplainer(args: {
  settings: AppSettings;
  userMessage: string;
  answer: string;
  capability: string;
  reason: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      `User request:\n${args.userMessage}`,
      "",
      `Answer produced:\n${clip(args.answer, 1_500)}`,
      "",
      `The limitation hit (capability "${args.capability}"): ${args.reason}`,
      "",
      "What the engine can do (for grounding): it runs its own local browser the assistant fully controls, so it can capture data the page's security policy blocks in-browser — full request/response bodies, WebSocket payloads — using the user's own logged-in session.",
      "",
      "Write the 1-2 sentence explanation now."
    ].join("\n")
  }];

  try {
    const response = await callAnthropicMessage({
      settings: args.settings,
      model: args.model,
      system: EXPLAINER_SYSTEM_PROMPT,
      messages,
      signal: args.signal
    });
    return extractText(response.content).trim();
  } catch {
    return "";
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
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
