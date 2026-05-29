/**
 * Front-door router: one cheap model call that classifies a prompt as `chat`
 * (answer directly from the model, no tools / no overlay / no pipeline) or
 * `tools` (run the existing plan→execute→gate pipeline).
 *
 * This is ADDITIVE — it does not suppress or replace any downstream model work.
 * `tools` runs the pipeline exactly as before; `chat` produces a normal model
 * answer. The point is to stop pure-chat prompts from painting an overlay and
 * spinning up the planner, and to stop the planner from guessing a tool for a
 * prompt that needed none.
 *
 * Conservative by design: anything that plausibly touches the current page, the
 * web, files, or "do something" is `tools`. Only clearly self-contained
 * conversation/knowledge/writing prompts are `chat`. On any uncertainty or
 * failure the caller defaults to `tools` so we never strand a real task in chat.
 */

import { callAnthropicMessage, extractText } from "../../model/anthropicToolClient";
import type { AppSettings } from "../../settings/settingsStore";
import type { ChatContextMessage } from "../../conversation/conversationTypes";
import { renderHistory } from "./conversationHistory";

export type RouteDecision = "chat" | "tools";

const ROUTER_SYSTEM_PROMPT = [
  "You are a fast router for a browser assistant. Decide whether a user prompt needs TOOLS or is plain CHAT.",
  "",
  "Answer TOOLS when the prompt needs anything beyond the model's own knowledge:",
  "- acting on / reading / summarizing the current page, a website, or a link",
  "- clicking, typing, navigating, filling forms, or interacting with a page",
  "- searching the web, opening a URL, or fetching current/real-world info",
  "- reading or writing local files / a workspace",
  "- anything referring to 'this page', 'that', 'the site', 'my tab', a button, or a result",
  "",
  "Answer CHAT only when the prompt is fully self-contained and answerable from general knowledge or by transforming text the user already gave:",
  "- greetings, definitions, explanations, opinions, brainstorming",
  "- writing/rewriting/translating text provided in the conversation",
  "- math, coding help, or reasoning that needs no external lookup",
  "",
  "When in doubt, answer TOOLS. Consider the prior conversation: a follow-up like 'go deeper' or 'do the same' inherits the previous turn's nature.",
  "",
  "Reply with EXACTLY one word, lowercase: tools OR chat. No punctuation, no explanation."
].join("\n");

/**
 * Classify the prompt. Returns `tools` on any error or unexpected output so a
 * real task is never stranded in chat.
 */
export async function routePrompt(args: {
  userMessage: string;
  settings: AppSettings;
  history?: ChatContextMessage[];
  signal?: AbortSignal;
}): Promise<RouteDecision> {
  try {
    const historyText = renderHistory(args.history);
    const userContent = [
      historyText ? `Recent conversation:\n${historyText}\n` : "",
      `Current user prompt:\n${args.userMessage}`,
      "",
      "Route (one word, tools or chat):"
    ]
      .filter(Boolean)
      .join("\n");

    const response = await callAnthropicMessage({
      settings: args.settings,
      // Router is cheap by intent; if the chat model is already the fast one this
      // is a no-op, but we never upgrade it to a heavier model for routing.
      system: ROUTER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      signal: args.signal
    });
    return parseRouteDecision(extractText(response.content));
  } catch {
    return "tools";
  }
}

/** Parse the model's one-word reply; default to `tools` for anything unclear. */
export function parseRouteDecision(text: string): RouteDecision {
  const normalized = text.trim().toLowerCase();
  // Be lenient about stray punctuation/quoting while staying default-tools.
  if (/^["'`]*chat\b/.test(normalized) || normalized === "chat") {
    return "chat";
  }
  return "tools";
}
