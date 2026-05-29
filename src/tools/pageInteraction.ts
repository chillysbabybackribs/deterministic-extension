import {
  checkConditionInPage,
  collectPageObservation,
  runPageInteraction
} from "./interaction/pageInteractionInjected";
import type {
  ObserveOptions,
  PageActionOptions,
  PageActionTarget,
  PageActionTargetSource,
  PageCondition,
  PageConditionCheck,
  PageInteractionAction,
  PageInteractionResult,
  PageObservation
} from "./interaction/pageInteractionTypes";

export type {
  PageActionOptions,
  PageActionTarget,
  PageCondition,
  PageConditionCheck,
  PageInteractionAction,
  PageInteractionResult,
  PageObservation,
  PageObservedElement
} from "./interaction/pageInteractionTypes";

const DEFAULT_MAX_OBSERVED_ELEMENTS = 80;
const MAX_OBSERVED_ELEMENTS = Number.MAX_SAFE_INTEGER;

export async function observeTab(tabId: number, options: ObserveOptions = {}): Promise<PageObservation> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageObservation,
    args: [{
      maxElements: clampInteger(options.maxElements, DEFAULT_MAX_OBSERVED_ELEMENTS, 1, MAX_OBSERVED_ELEMENTS),
      includeInvisible: options.includeInvisible === true
    }]
  });

  if (!result?.result) {
    throw new Error("Page observation returned no content.");
  }

  return result.result;
}

export async function performPageAction(
  tabId: number,
  action: PageInteractionAction,
  target: PageActionTarget,
  options: PageActionOptions = {}
): Promise<PageInteractionResult> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: runPageInteraction,
    args: [action, target, options]
  });

  if (!result?.result) {
    throw new Error("Page interaction returned no result.");
  }

  return result.result;
}

export async function checkPageCondition(tabId: number, condition: PageCondition): Promise<PageConditionCheck> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: checkConditionInPage,
    args: [condition]
  });

  if (!result?.result) {
    throw new Error("Page condition check returned no result.");
  }

  return result.result;
}

export function normalizePageActionTarget(input: unknown): PageActionTarget {
  const source = isRecord(input) && isRecord(input.target)
    ? input.target as PageActionTargetSource
    : isRecord(input)
      ? input as PageActionTargetSource
      : {};
  const target: PageActionTarget = {};

  for (const key of ["elementRef", "selector", "text", "role", "name", "label", "placeholder"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      target[key] = value.trim();
    }
  }

  if (typeof source.index === "number" && Number.isFinite(source.index) && source.index >= 0) {
    target.index = Math.floor(source.index);
  }

  if (typeof source.overlayIndex === "number" && Number.isFinite(source.overlayIndex) && source.overlayIndex >= 1) {
    target.overlayIndex = Math.floor(source.overlayIndex);
  }

  return target;
}

export function hasPageActionTarget(target: PageActionTarget): boolean {
  return Boolean(
    target.overlayIndex !== undefined ||
    target.elementRef ||
    target.selector ||
    target.text ||
    target.role ||
    target.name ||
    target.label ||
    target.placeholder
  );
}

export function normalizePageCondition(input: unknown): PageCondition {
  const source = isRecord(input) && isRecord(input.condition)
    ? input.condition as Record<string, unknown>
    : isRecord(input)
      ? input
      : {};
  const condition: PageCondition = {};

  for (const key of ["selector", "text", "urlIncludes", "titleIncludes"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      condition[key] = value.trim();
    }
  }

  const elementState = source.elementState;
  if (
    elementState === "present" ||
    elementState === "visible" ||
    elementState === "hidden" ||
    elementState === "absent"
  ) {
    condition.elementState = elementState;
  } else if (condition.selector) {
    condition.elementState = "visible";
  }

  return condition;
}

export function hasPageCondition(condition: PageCondition): boolean {
  return Boolean(condition.selector || condition.text || condition.urlIncludes || condition.titleIncludes);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
