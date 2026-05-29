/**
 * The MERGE + GATE step.
 *
 * After each deterministic execution round produces a summary, the model:
 *   1. MERGES that summary into the running accumulator (dedup / rewrite /
 *      reconcile across rounds), and
 *   2. judges SUFFICIENCY against the user's prompt, returning one of:
 *        - "synthesize": enough to fully answer -> write the final answer.
 *        - "grep":       the missing detail was probably already gathered ->
 *                        run a targeted grep over the stored extraction.
 *        - "replan":     genuinely new info needed -> build a new plan.
 *      plus `missing` (what's still needed) and the merged `accumulator`.
 *
 * The model sees only the prompt + summaries — never raw extraction.
 */

import {
  callAnthropicMessage,
  extractText,
  type AnthropicMessageParam
} from "../../model/anthropicToolClient";
import type { AppSettings } from "../../settings/settingsStore";
import { renderHistory } from "./conversationHistory";
import type { ChatContextMessage } from "../../conversation/conversationTypes";
import { describeActiveSource, type ActiveWorkingFileDescriptor } from "../../filecorpus/corpusTypes";

export type GateDecision = "synthesize" | "grep" | "replan";

export type GateResult = {
  decision: GateDecision;
  /** The merged, deduped running summary across all rounds so far. */
  accumulator: string;
  /** What is still missing (empty when synthesize). */
  missing: string;
  /** For decision="grep": the query to run over stored extractions. */
  grepQuery?: string;
  raw: string;
};

const GATE_SYSTEM_PROMPT = [
  "You are the sufficiency gate for a deterministic research/automation pipeline.",
  "You receive the user's prompt, the running accumulated summary, and the newest round's summary.",
  "First, merge the newest summary into the accumulated summary: dedup, reconcile contradictions, keep everything relevant, drop noise.",
  "Then decide if the merged accumulator is sufficient to FULLY answer the user's prompt.",
  "Choose exactly one decision:",
  "- synthesize: the accumulator is sufficient; the final answer can be written from it.",
  "- grep: more detail is needed AND it was probably already gathered this task; provide a grepQuery to search the stored data cheaply.",
  "- replan: genuinely new information is needed that has not been gathered.",
  "CRITICAL — terminal limitations are NOT a reason to replan or grep. A summary may state that some data is permanently unavailable (e.g. 'response bodies could not be captured due to the page's Content-Security-Policy', 'capture blocked', 'opaque cross-origin response', 'requires login you do not have'). Replanning CANNOT recover data the source itself reports as unobtainable — re-running the same tools will return the same limitation. When the ONLY thing missing is data flagged as terminally unavailable, choose synthesize and answer with what WAS gathered, noting the limitation. Only replan when the missing info is plausibly obtainable by a DIFFERENT tool or action that has not been tried.",
  "CRITICAL — if the newest summary says planned page steps were deferred until the next planning round, those deferred steps are still missing. Choose replan unless the merged accumulator already fully satisfies the user's request without the deferred page work.",
  "WORKING FILE (hybrid grounding): when one is attached and the accumulator lacks the detail to answer, FIRST prefer replan with a broader or differently-worded query_file (state this in `missing`). If a query_file step has ALREADY run and the file genuinely does not contain the answer, do NOT keep re-querying it — instead either (a) replan a search_web step to fill the gap from the web when the user's question is answerable from general/public knowledge, noting in `missing` that the file lacked it; or (b) synthesize and state plainly what the file does and does not contain when a web search would not help. The goal is to answer the user, preferring the file but escalating to the web when the file falls short.",
  "Return ONLY JSON: {\"decision\":\"synthesize|grep|replan\",\"accumulator\":\"<merged summary>\",\"missing\":\"<what's still needed, or empty>\",\"grepQuery\":\"<only when decision=grep>\"}"
].join("\n");

export async function runGate(args: {
  settings: AppSettings;
  userMessage: string;
  history?: ChatContextMessage[];
  priorAccumulator: string;
  newSummary: string;
  activeWorkingFile?: ActiveWorkingFileDescriptor;
  model?: string;
  signal?: AbortSignal;
}): Promise<GateResult> {
  const historyText = renderHistory(args.history);
  const workingFile = args.activeWorkingFile;
  const messages: AnthropicMessageParam[] = [{
    role: "user",
    content: [
      historyText ? `Earlier in this conversation:\n${historyText}\n` : "",
      `User prompt:\n${args.userMessage}`,
      workingFile ? `\nThe user has attached ${describeActiveSource(workingFile)} as the working source.` : "",
      "",
      args.priorAccumulator ? `Accumulated summary so far:\n${args.priorAccumulator}` : "Accumulated summary so far:\n(none yet)",
      "",
      `Newest round summary:\n${args.newSummary}`,
      "",
      "Merge and decide. Output the JSON now."
    ].join("\n")
  }];

  const response = await callAnthropicMessage({
    settings: args.settings,
    model: args.model,
    system: GATE_SYSTEM_PROMPT,
    messages,
    signal: args.signal
  });
  return parseGate(extractText(response.content), { priorAccumulator: args.priorAccumulator, newSummary: args.newSummary });
}

/**
 * Parse a gate response. Pure + unit-testable. Falls back safely: unparseable
 * output becomes a "synthesize" with the concatenated summaries as accumulator,
 * so the pipeline can still answer rather than loop forever.
 */
export function parseGate(
  raw: string,
  fallback: { priorAccumulator: string; newSummary: string }
): GateResult {
  const merged = [fallback.priorAccumulator, fallback.newSummary].filter(Boolean).join("\n\n");
  const parsed = tolerantJsonObject(raw);
  if (!parsed) {
    return { decision: "synthesize", accumulator: merged, missing: "", raw };
  }

  const decision: GateDecision =
    parsed.decision === "grep" ? "grep" : parsed.decision === "replan" ? "replan" : "synthesize";
  const accumulator = typeof parsed.accumulator === "string" && parsed.accumulator.trim()
    ? parsed.accumulator
    : merged;
  const missing = typeof parsed.missing === "string" ? parsed.missing : "";
  const grepQuery = decision === "grep" && typeof parsed.grepQuery === "string" && parsed.grepQuery.trim()
    ? parsed.grepQuery
    : undefined;

  // A grep decision with no usable query can't proceed as grep — treat as replan.
  if (decision === "grep" && !grepQuery) {
    return { decision: "replan", accumulator, missing: missing || "needed detail not specified", raw };
  }

  return { decision, accumulator, missing, grepQuery, raw };
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
