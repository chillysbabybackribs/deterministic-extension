/**
 * Model-selection policy ("model awareness").
 *
 * A single pure function decides WHICH model each step of a turn should use,
 * combining two inputs:
 *   1. STEP ROLE — mechanical decisions (router, gate, follow-up) want the cheap
 *      fast tier; user-facing / reasoning-heavy steps (planner, synthesis, chat)
 *      want the stronger tier.
 *   2. TASK COMPLEXITY — a cheap label derived from the prompt (length is the
 *      primary factor) that can bump a step up a tier for harder asks.
 *
 * This is ADDITIVE and keeps every model call in the loop — it only picks which
 * model runs each call (per the standing constraint: do not suppress models).
 *
 * Provider-agnostic: the registry tags each model with its provider so a future
 * Gemini/OpenAI cheap tier can slot in without touching call sites. Only the two
 * Anthropic models are wired today; the structure admits more.
 *
 * Leaf module: no pipeline/UI imports.
 */

import { CLAUDE_HAIKU_4_5_MODEL, CLAUDE_SONNET_4_6_MODEL, type ModelSettings } from "../settings/modelSettings";
import type { ProviderId } from "../settings/providerSettings";

/** The pipeline steps that make a model call. */
export type ModelStep = "router" | "planner" | "gate" | "synthesis" | "followup" | "chat";

/** Coarse complexity label for a whole turn. */
export type TaskComplexity = "simple" | "standard" | "complex";

/** A concrete model choice, provider-tagged so call sites stay provider-agnostic. */
export type ModelChoice = {
  provider: ProviderId;
  model: string;
};

/** Capability tier. `fast` = cheap/mechanical; `strong` = reasoning/user-facing. */
export type ModelTier = "fast" | "strong";

/**
 * Tier → concrete model. Today both tiers resolve to Anthropic models from the
 * user's settings (fast = chat model, which defaults to Haiku; strong = the
 * researchSynthesis "best" choice, falling back to Sonnet). A provider with a
 * cheaper fast model would override the `fast` entry here.
 */
function registryFor(settings: ModelSettings): Record<ModelTier, ModelChoice> {
  const fast: ModelChoice = { provider: "anthropic", model: settings.model };
  // "strong" prefers an explicit researchSynthesis pick; "auto"/unset → Sonnet.
  const strongModel =
    settings.researchSynthesisModel && settings.researchSynthesisModel !== "auto"
      ? settings.researchSynthesisModel
      : CLAUDE_SONNET_4_6_MODEL;
  return {
    fast,
    strong: { provider: "anthropic", model: strongModel }
  };
}

/** Base tier per step, before complexity adjustment. */
const STEP_BASE_TIER: Record<ModelStep, ModelTier> = {
  router: "fast",
  gate: "fast",
  followup: "fast",
  planner: "fast",
  synthesis: "strong",
  chat: "strong"
};

/**
 * Label a turn's complexity from the prompt. Length is the primary factor (a
 * long, detailed prompt is usually a harder task), nudged by a couple of cheap
 * signals: multi-part asks ("and then", multiple sentences) and reasoning words.
 * Deliberately simple and deterministic — no model call.
 */
export function classifyComplexity(prompt: string): TaskComplexity {
  const text = prompt.trim();
  const length = text.length;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 3).length;
  const multiPart = /\band then\b|\bafter that\b|\bstep \d|\bfirst\b.*\bthen\b/i.test(text);
  const reasoning = /\b(why|explain|compare|analy[sz]e|trade-?offs?|design|architect|differ|differences?|debug|prove|derive|best (?:for|choice|option))\b/i.test(text);
  // Enumerating three or more things ("X, Y, and Z" or "X vs Y vs Z") is a strong
  // complexity signal on its own — a single long sentence can be a hard
  // multi-entity comparison even without ".", "and then" sentence breaks.
  const enumeration =
    /\b\w[\w.+#-]*,\s+\w[\w.+#-]*,\s+(?:and|or)\s+\w/i.test(text) ||
    /\b\w[\w.+#-]*\s+vs\.?\s+\w[\w.+#-]*\s+vs\.?\s+\w/i.test(text);

  let score = 0;
  if (length > 600) score += 2;
  else if (length > 240) score += 1;
  if (sentences >= 4) score += 1;
  if (multiPart) score += 1;
  if (reasoning) score += 1;
  if (enumeration) score += 1;
  // A multi-part AND reasoning-heavy ask is complex regardless of length —
  // length is a factor, not the sole gate.
  if (multiPart && reasoning) score += 1;
  // A comparison ACROSS several enumerated things is the canonical "complex"
  // research turn (e.g. "compare X, Y, and Z") — bump it even when it is one long
  // sentence with no other multi-part markers.
  if (enumeration && reasoning) score += 1;

  if (score >= 3) return "complex";
  if (score >= 1) return "standard";
  return "simple";
}

/** Bump a tier up one level (fast → strong). `strong` is the ceiling. */
function bumpTier(tier: ModelTier): ModelTier {
  return tier === "fast" ? "strong" : "strong";
}

/**
 * Choose the model for a step given the turn's complexity and the user's
 * settings. A `complex` task bumps mechanical steps up to the strong tier so the
 * planner/gate reason better on hard asks; a `simple` task leaves bases as-is.
 * `standard` keeps the base tiers.
 */
export function selectModel(args: {
  step: ModelStep;
  complexity: TaskComplexity;
  settings: ModelSettings;
}): ModelChoice {
  const registry = registryFor(args.settings);
  let tier = STEP_BASE_TIER[args.step];
  if (args.complexity === "complex") {
    tier = bumpTier(tier);
  }
  return registry[tier];
}
