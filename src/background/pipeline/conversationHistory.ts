/**
 * Conversation-history helpers shared by the pipeline's model steps.
 *
 * The UI already sends the prior turns (RunRequest.history) capped to the last
 * dozen messages; the pipeline threads that same array into the planner, gate,
 * synthesis, and follow-up steps so a follow-up prompt ("now do the same for the
 * API", "go deeper on that") is interpreted against what came before instead of
 * in isolation. Rendering lives here so every step formats history identically
 * and bounds it the same way.
 */

import type { ChatContextMessage } from "../../conversation/conversationTypes";

/** Per-message content cap so a long prior answer can't dominate the prompt. */
const MAX_MESSAGE_CHARS = 1_200;
/** Hard cap on turns fed to any single step (UI already trims to ~12). */
const MAX_TURNS = 12;

/**
 * Render prior turns as a compact transcript for a model prompt, or undefined
 * when there is no usable history. The CURRENT user message is NOT included
 * here — callers pass that separately as the live prompt; history is only the
 * turns that preceded it.
 */
export function renderHistory(history: ChatContextMessage[] | undefined): string | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }
  const turns = history.slice(-MAX_TURNS);
  const lines: string[] = [];
  for (const turn of turns) {
    const role = turn.role === "user" ? "User" : "Assistant";
    const content = turn.content.trim();
    if (!content) {
      continue;
    }
    const clipped = content.length > MAX_MESSAGE_CHARS
      ? `${content.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
      : content;
    lines.push(`${role}: ${clipped}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * History minus the trailing current user turn. The UI's history array includes
 * the just-sent message as the last entry; for prompts that pass the current
 * message separately we drop that trailing user turn to avoid duplicating it.
 */
export function priorTurns(
  history: ChatContextMessage[] | undefined,
  currentMessage: string
): ChatContextMessage[] | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.content.trim() === currentMessage.trim()) {
    const trimmed = history.slice(0, -1);
    return trimmed.length ? trimmed : undefined;
  }
  return history;
}
