import { runElementCaptureOverlay } from "./capture/captureOverlay";
import type {
  CapturedUiComponentIR,
  CapturedUiComponentIntent,
  CapturedUiComponentKind,
  CapturedUiDisplaySummary,
  CapturedUiElement,
  CapturedUiHitElement,
  CapturedUiIntelligenceProfiles,
  CapturedUiQualityProfile,
  CapturedUiReference,
  CapturedUiSelectorConfidence,
  CapturedUiStyleProfile,
  CapturedUiStyleSummary,
  CaptureScriptResult
} from "./capture/capturedUiTypes";

export type {
  CaptureScriptResult,
  CapturedUiAccessibilityProfile,
  CapturedUiAssetBackgroundImage,
  CapturedUiAssetImage,
  CapturedUiAssetProfile,
  CapturedUiAssetSvg,
  CapturedUiAssetVideo,
  CapturedUiBounds,
  CapturedUiComponentIR,
  CapturedUiComponentIntent,
  CapturedUiComponentKind,
  CapturedUiCssVariableClue,
  CapturedUiDisplaySummary,
  CapturedUiElement,
  CapturedUiHitElement,
  CapturedUiIntelligenceProfiles,
  CapturedUiLayoutContext,
  CapturedUiLayoutElementSummary,
  CapturedUiPointer,
  CapturedUiQualityProfile,
  CapturedUiReference,
  CapturedUiSelectorConfidence,
  CapturedUiSourceClues,
  CapturedUiStyleProfile,
  CapturedUiStyleSummary,
  CapturedUiViewport
} from "./capture/capturedUiTypes";

const ACTIVE_CAPTURE_CONTEXT_MAX_CHARS = 12_000;
const CAPTURE_CANCEL_EVENT = "__ohmygod_cancel_ui_capture__";

export async function captureUiFromActiveTab(): Promise<CapturedUiReference | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available for UI capture.");
  }
  if (!isCaptureSupportedUrl(tab.url)) {
    throw new Error("Capture UI works on normal HTTPS pages in this Chrome Web Store v1 build. Chrome internal pages such as chrome:// cannot be captured.");
  }

  let result: chrome.scripting.InjectionResult<CaptureScriptResult> | undefined;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runElementCaptureOverlay,
      args: [CAPTURE_CANCEL_EVENT]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/chrome:\/\//i.test(tab.url ?? "") || /Cannot access a chrome:\/\/ URL/i.test(message)) {
      throw new Error("Capture UI works on normal HTTPS pages in this Chrome Web Store v1 build. Chrome internal pages such as chrome:// cannot be captured.");
    }
    throw error;
  }

  const value = result?.result as CaptureScriptResult | undefined;
  if (!value) {
    throw new Error("UI capture returned no result.");
  }

  return value.status === "captured" ? addCapturedUiIntelligenceProfiles(value.capture) : undefined;
}

export async function cancelUiCaptureInActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCaptureSupportedUrl(tab.url)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: dispatchCaptureCancelEvent,
    args: [CAPTURE_CANCEL_EVENT]
  }).catch(() => undefined);
}

function isCaptureSupportedUrl(url: string | undefined): boolean {
  return Boolean(url && /^https:/i.test(url));
}

function dispatchCaptureCancelEvent(eventName: string): void {
  window.dispatchEvent(new CustomEvent(eventName));
}

export function addCapturedUiIntelligenceProfiles(reference: CapturedUiReference): CapturedUiReference {
  const style = buildStyleProfile(reference.element.computedStyle);
  const styledReference: CapturedUiReference = {
    ...reference,
    profiles: {
      ...reference.profiles,
      style
    }
  };
  const component = buildComponentIr(styledReference);
  const componentReference: CapturedUiReference = {
    ...styledReference,
    profiles: {
      ...styledReference.profiles,
      component
    }
  };

  return {
    ...componentReference,
    profiles: {
      ...componentReference.profiles,
      quality: buildQualityProfile(componentReference)
    }
  };
}

export function formatCapturedUiReferenceForRequest(reference: CapturedUiReference): string {
  const json = stringifyCapturedUiReference(reference);
  const clippedJson = json.length > ACTIVE_CAPTURE_CONTEXT_MAX_CHARS
    ? `${json.slice(0, ACTIVE_CAPTURE_CONTEXT_MAX_CHARS)}\n... truncated`
    : json;

  return [
    "Active captured UI context for this user request.",
    "The user recently captured a UI element from the browser. Treat references to \"this\", \"that element\", \"the captured UI\", or \"the selected UI\" as referring to this captured UI.",
    "Use the structured data below for visual, semantic, layout, and style details.",
    "If profiles.component is present, treat it as deterministic component/template input and prefer its kind, intent, templateHints, and limitations over guessing from raw fields.",
    "",
    "```json",
    clippedJson,
    "```"
  ].join("\n");
}

export function formatCapturedUiDisplaySummary(reference: CapturedUiReference): CapturedUiDisplaySummary {
  const element = reference.element;
  const label = labelForCapturedElement(element);
  const role = element.role || inferredDisplayRole(element);
  const elementDescription = describeDisplayElement(label, role || element.tagName);
  const sourceDomain = domainForUrl(reference.url);
  const styleSummary = compactDisplayStyle(element);
  const hitElement = reference.hitElement && reference.hitElement.selector !== element.selector
    ? describeHitElement(reference.hitElement, element)
    : undefined;
  const component = reference.profiles?.component;

  return {
    title: "Captured UI",
    subtitle: elementDescription,
    sourceTitle: reference.title || sourceDomain || reference.url,
    sourceUrl: reference.url,
    sourceDomain,
    elementLabel: label,
    elementDescription,
    selector: element.selector,
    selectorConfidence: element.selectorConfidence,
    tagName: element.tagName,
    role,
    bounds: {
      width: element.bounds.width,
      height: element.bounds.height
    },
    styleSummary,
    semanticContext: semanticContextForElement(element),
    hitElement,
    component: component ? {
      kind: component.kind,
      intent: component.intent,
      confidence: component.confidence,
      templateHints: component.templateHints.slice(0, 3),
      limitations: component.limitations.slice(0, 3)
    } : undefined
  };
}

export function formatCapturedUiDisplayText(summary: CapturedUiDisplaySummary): string {
  return [
    `Captured UI: <${summary.tagName}> ${summary.elementDescription}`,
    `Source: ${summary.sourceTitle}`,
    `Selector: ${summary.selector} (${summary.selectorConfidence} confidence)`
  ].join("\n");
}

function stringifyCapturedUiReference(reference: CapturedUiReference): string {
  const compactProfiles = compactProfilesForRequest(reference.profiles);
  const compact = pruneEmptyValues({
    captureId: reference.captureId,
    url: reference.url,
    title: reference.title,
    viewport: reference.viewport,
    pointer: reference.pointer,
    element: reference.element,
    hitElement: reference.hitElement,
    profiles: compactProfiles
  });
  return JSON.stringify(compact, null, 2);
}

function compactProfilesForRequest(profiles: CapturedUiIntelligenceProfiles | undefined): CapturedUiIntelligenceProfiles | undefined {
  if (!profiles) {
    return undefined;
  }

  return pruneEmptyValues({
    ...profiles,
    layoutContext: profiles.layoutContext ? {
      ...profiles.layoutContext,
      previousSiblings: profiles.layoutContext.previousSiblings.slice(-3),
      nextSiblings: profiles.layoutContext.nextSiblings.slice(0, 3),
      children: profiles.layoutContext.children.slice(0, 6)
    } : undefined
  }) as CapturedUiIntelligenceProfiles | undefined;
}

function describeCapturedElement(element: CapturedUiElement | CapturedUiHitElement): string {
  return element.accessibleName ??
    element.textPreview ??
    element.ariaLabel ??
    element.href ??
    element.alt ??
    element.selector;
}

function labelForCapturedElement(element: CapturedUiElement): string {
  const value = element.accessibleName ??
    element.ariaLabel ??
    element.alt ??
    element.textPreview ??
    element.placeholder ??
    pathOrDomainForHref(element.href);
  if (value) {
    return value;
  }

  const role = element.role || inferredDisplayRole(element);
  return role ? `${role} ${element.tagName}` : element.tagName;
}

function describeDisplayElement(label: string, roleOrTag: string): string {
  if (!roleOrTag) {
    return label;
  }

  return label.toLowerCase().endsWith(roleOrTag.toLowerCase()) ? label : `${label} ${roleOrTag}`;
}

function inferredDisplayRole(element: CapturedUiElement): string | undefined {
  if (element.tagName === "a" && element.href) {
    return "link";
  }
  if (element.tagName === "img") {
    return "image";
  }
  if (element.tagName === "button") {
    return "button";
  }
  if (element.tagName === "input" || element.tagName === "textarea" || element.tagName === "select") {
    return "input";
  }
  return undefined;
}

function compactDisplayStyle(element: CapturedUiElement): CapturedUiDisplaySummary["styleSummary"] {
  const style = element.computedStyle;
  const font = [shortFontFamily(style.fontFamily), style.fontSize, style.fontWeight && style.fontWeight !== "400" ? style.fontWeight : ""]
    .filter(Boolean)
    .join(" ");
  return omitEmptyDisplayStyle({
    font: font || undefined,
    color: compactCssColor(style.color),
    background: isTransparentColor(style.backgroundColor) ? "transparent" : compactCssColor(style.backgroundColor),
    radius: style.borderRadius && style.borderRadius !== "0px" ? style.borderRadius : undefined,
    shadow: style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : undefined
  });
}

function buildStyleProfile(style: CapturedUiStyleSummary): CapturedUiStyleProfile {
  const text = compactCssColor(style.color);
  const background = isTransparentColor(style.backgroundColor) ? "transparent" : compactCssColor(style.backgroundColor);
  const profile: CapturedUiStyleProfile = {
    typography: omitUndefinedValues({
      fontFamily: shortFontFamily(style.fontFamily),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight
    }),
    colors: omitUndefinedValues({
      text,
      background
    }),
    spacing: omitUndefinedValues({
      padding: style.padding,
      margin: style.margin
    }),
    shape: omitUndefinedValues({
      border: style.border,
      borderRadius: style.borderRadius && style.borderRadius !== "0px" ? style.borderRadius : undefined,
      boxShadow: style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : undefined
    }),
    layout: omitUndefinedValues({
      display: style.display,
      position: style.position
    }),
    visualTags: styleVisualTags(style)
  };

  return omitEmptyProfileSections(profile);
}

function buildComponentIr(reference: CapturedUiReference): CapturedUiComponentIR {
  const element = reference.element;
  const profiles = reference.profiles;
  const style = profiles?.style ?? buildStyleProfile(element.computedStyle);
  const layout = profiles?.layoutContext;
  const assets = profiles?.assets;
  const accessibility = profiles?.accessibility;
  const sourceClues = profiles?.sourceClues;
  const classification = classifyCapturedComponent(reference);
  const limitations = componentLimitations(reference, classification.kind);

  return {
    kind: classification.kind,
    intent: intentForComponentKind(classification.kind),
    confidence: confidenceForComponentScore(classification.score, element.selectorConfidence, limitations.length),
    score: classification.score,
    label: labelForCapturedElement(element),
    role: element.role || inferredDisplayRole(element),
    tagName: element.tagName,
    selector: element.selector,
    content: omitUndefinedValues({
      text: element.textPreview,
      href: element.href,
      src: element.src,
      alt: element.alt,
      placeholder: element.placeholder,
      valuePreview: element.valuePreview
    }),
    behavior: omitUndefinedBooleanValues({
      disabled: element.disabled,
      checked: element.checked,
      type: element.type,
      focusable: accessibility?.focusable
    }),
    structure: omitUndefinedComponentStructure({
      container: layout?.nearestSemanticContainer?.tagName ?? layout?.parent?.tagName,
      parentDisplay: layout?.parent?.display,
      childCount: layout?.childCount,
      siblingCount: layout?.siblingCount,
      hasIcon: Boolean(assets?.svgs.some((asset) => asset.iconLike)),
      hasImage: Boolean(assets?.images.length)
    }),
    appearance: {
      typography: style.typography,
      colors: style.colors,
      spacing: style.spacing,
      shape: style.shape,
      layout: style.layout,
      visualTags: style.visualTags
    },
    accessibility: omitUndefinedAccessibilitySummary({
      accessibleName: accessibility?.accessibleName ?? element.accessibleName,
      focusable: accessibility?.focusable,
      issues: accessibility?.issues?.length ? accessibility.issues : undefined
    }),
    sourceHints: omitUndefinedSourceHints({
      frameworks: sourceClues?.frameworkHints.length ? sourceClues.frameworkHints.slice(0, 4) : undefined,
      componentLibraries: sourceClues?.componentLibraryHints.length ? sourceClues.componentLibraryHints.slice(0, 4) : undefined,
      fonts: sourceClues?.fontFamilies.length ? sourceClues.fontFamilies.slice(0, 4) : undefined
    }),
    templateHints: templateHintsForComponent(reference, classification.kind).slice(0, 8),
    limitations
  };
}

function buildQualityProfile(reference: CapturedUiReference): CapturedUiQualityProfile {
  const element = reference.element;
  const component = reference.profiles?.component;
  const stableSelector = element.selectorConfidence !== "low";
  const promotedTarget = Boolean(reference.hitElement && reference.hitElement.selector !== element.selector);
  const limitations = captureQualityLimitations(reference);
  const signals = captureQualitySignals(reference);
  let score = 45;

  if (element.selectorConfidence === "high") {
    score += 18;
  } else if (element.selectorConfidence === "medium") {
    score += 10;
  } else {
    score -= 10;
  }
  if (element.accessibleName || element.ariaLabel || element.textPreview || element.alt || element.placeholder) {
    score += 12;
  }
  if (component && component.kind !== "unknown") {
    score += 14;
  }
  if (component?.confidence === "high") {
    score += 8;
  } else if (component?.confidence === "low") {
    score -= 8;
  }
  if (reference.profiles?.style?.visualTags.length) {
    score += 6;
  }
  if (reference.profiles?.layoutContext?.parent || reference.profiles?.layoutContext?.nearestSemanticContainer) {
    score += 5;
  }
  if (promotedTarget) {
    score += 3;
  }
  score -= limitations.length * 6;
  score = Math.max(0, Math.min(100, score));

  return {
    confidence: score >= 78 ? "high" : score >= 52 ? "medium" : "low",
    score,
    stableSelector,
    promotedTarget,
    usableForTemplate: score >= 52 && component?.kind !== "unknown",
    signals: signals.slice(0, 8),
    limitations: limitations.slice(0, 8)
  };
}

function captureQualitySignals(reference: CapturedUiReference): string[] {
  const signals: string[] = [];
  const element = reference.element;
  const component = reference.profiles?.component;
  if (element.selectorConfidence !== "low") {
    signals.push(`${element.selectorConfidence} confidence selector`);
  }
  if (element.accessibleName || element.ariaLabel) {
    signals.push("accessible name available");
  } else if (element.textPreview || element.alt || element.placeholder) {
    signals.push("visible label/text available");
  }
  if (component && component.kind !== "unknown") {
    signals.push(`classified as ${component.kind}`);
  }
  if (reference.profiles?.style?.visualTags.length) {
    signals.push("style profile available");
  }
  if (reference.profiles?.layoutContext?.nearestSemanticContainer) {
    signals.push("semantic container available");
  } else if (reference.profiles?.layoutContext?.parent) {
    signals.push("parent layout available");
  }
  if (reference.profiles?.assets && (
    reference.profiles.assets.images.length ||
    reference.profiles.assets.svgs.length ||
    reference.profiles.assets.backgroundImages.length ||
    reference.profiles.assets.videos.length
  )) {
    signals.push("asset clues available");
  }
  if (reference.profiles?.sourceClues?.frameworkHints.length || reference.profiles?.sourceClues?.componentLibraryHints.length) {
    signals.push("source clues available");
  }
  if (reference.hitElement && reference.hitElement.selector !== element.selector) {
    signals.push("semantic target promotion applied");
  }
  return Array.from(new Set(signals));
}

function captureQualityLimitations(reference: CapturedUiReference): string[] {
  const limitations: string[] = [];
  const element = reference.element;
  const component = reference.profiles?.component;
  if (element.selectorConfidence === "low") {
    limitations.push("selector is structurally fragile");
  }
  if (!element.accessibleName && !element.ariaLabel && !element.textPreview && !element.alt && !element.placeholder) {
    limitations.push("selected element has weak label context");
  }
  if (component?.kind === "unknown") {
    limitations.push("component kind is unknown");
  }
  if (component?.confidence === "low") {
    limitations.push("component classification confidence is low");
  }
  if (element.bounds.width <= 4 || element.bounds.height <= 4) {
    limitations.push("selected target has tiny bounds");
  }
  if (element.bounds.width > reference.viewport.width * 0.9 && element.bounds.height > reference.viewport.height * 0.75) {
    limitations.push("selected target covers most of the viewport");
  }
  if (reference.profiles?.accessibility?.issues.length) {
    limitations.push(...reference.profiles.accessibility.issues.slice(0, 3));
  }
  if (component?.limitations.length) {
    limitations.push(...component.limitations.slice(0, 3));
  }
  return Array.from(new Set(limitations));
}

function classifyCapturedComponent(reference: CapturedUiReference): { kind: CapturedUiComponentKind; score: number } {
  const element = reference.element;
  const tagName = element.tagName;
  const role = element.role;
  const layout = reference.profiles?.layoutContext;
  const assets = reference.profiles?.assets;
  const styleTags = reference.profiles?.style?.visualTags ?? styleVisualTags(element.computedStyle);
  const scores: Record<CapturedUiComponentKind, number> = {
    button: 0,
    link: 0,
    input: 0,
    image: 0,
    icon: 0,
    text: 0,
    nav: 0,
    form: 0,
    card: 0,
    section: 0,
    media: 0,
    unknown: 1
  };

  if (tagName === "button" || role === "button" || element.type === "button" || element.type === "submit") {
    scores.button += 90;
  }
  if (tagName === "a" || role === "link" || element.href) {
    scores.link += 88;
  }
  if (tagName === "input" || tagName === "textarea" || tagName === "select" || role === "textbox" || role === "checkbox" || role === "radio" || role === "combobox") {
    scores.input += 90;
  }
  if (tagName === "img" || element.src || element.alt) {
    scores.image += 86;
  }
  if (tagName === "video" || tagName === "audio" || Boolean(reference.profiles?.assets?.videos.length)) {
    scores.media += 82;
  }
  if (tagName === "nav" || role === "navigation" || layout?.nearestSemanticContainer?.tagName === "nav" || layout?.nearestSemanticContainer?.role === "navigation") {
    scores.nav += 80;
  }
  if (tagName === "form" || role === "form" || layout?.nearestSemanticContainer?.tagName === "form") {
    scores.form += 80;
  }
  if (assets?.svgs.some((asset) => asset.iconLike) && !element.textPreview && element.bounds.width <= 96 && element.bounds.height <= 96) {
    scores.icon += 72;
  }
  if (element.textPreview && !element.href && tagName !== "button" && tagName !== "input" && tagName !== "textarea") {
    scores.text += 44;
  }
  if (layout && layout.childCount >= 2 && layout.siblingCount >= 1 && (styleTags.includes("rounded") || styleTags.includes("shadow") || styleTags.includes("bordered"))) {
    scores.card += 68;
  }
  if ((tagName === "section" || tagName === "article" || role === "region") && layout && layout.childCount >= 2) {
    scores.section += 64;
  }
  if (styleTags.includes("filled")) {
    scores.button += tagName === "button" || role === "button" ? 12 : 0;
    scores.card += layout && layout.childCount >= 2 ? 8 : 0;
  }
  if (element.selectorConfidence === "high") {
    for (const key of Object.keys(scores) as CapturedUiComponentKind[]) {
      scores[key] += key === "unknown" ? 0 : 4;
    }
  }

  const [kind, score] = (Object.entries(scores) as Array<[CapturedUiComponentKind, number]>)
    .sort((left, right) => right[1] - left[1])[0];
  return { kind, score };
}

function intentForComponentKind(kind: CapturedUiComponentKind): CapturedUiComponentIntent {
  if (kind === "button") {
    return "action";
  }
  if (kind === "link" || kind === "nav") {
    return "navigation";
  }
  if (kind === "input" || kind === "form") {
    return "input";
  }
  if (kind === "image" || kind === "icon" || kind === "media") {
    return "media";
  }
  if (kind === "card" || kind === "section") {
    return "layout";
  }
  if (kind === "text") {
    return "content";
  }
  return "unknown";
}

function confidenceForComponentScore(score: number, selectorConfidence: CapturedUiSelectorConfidence, limitationCount: number): CapturedUiSelectorConfidence {
  if (score >= 80 && selectorConfidence !== "low" && limitationCount <= 1) {
    return "high";
  }
  if (score >= 55 && limitationCount <= 3) {
    return "medium";
  }
  return "low";
}

function templateHintsForComponent(reference: CapturedUiReference, kind: CapturedUiComponentKind): string[] {
  const element = reference.element;
  const hints: string[] = [];
  if (kind === "button") {
    hints.push("prefer local Button primitive when available", "preserve label and disabled/type state", "map filled/bordered/rounded style to variant tokens");
  }
  if (kind === "link") {
    hints.push("prefer local Link/NavLink primitive when available", "preserve href", "preserve accessible name");
  }
  if (kind === "input") {
    hints.push("prefer local Input/FormField primitive when available", "preserve name/type/placeholder/disabled state", "include associated label when available");
  }
  if (kind === "card") {
    hints.push("prefer local Card primitive when available", "preserve child order", "map radius/shadow/border to design tokens");
  }
  if (kind === "image") {
    hints.push("prefer local Image/media primitive when available", "preserve alt text", "treat source URL as reference, not copied asset");
  }
  if (kind === "nav") {
    hints.push("prefer local Header/Nav primitives when available", "preserve link labels and order", "map gap/alignment to layout tokens");
  }
  if (kind === "text") {
    hints.push("prefer local Typography/Text primitive when available", "map font size/weight/line height to type tokens");
  }
  if (element.href) {
    hints.push("preserve navigation target");
  }
  if (reference.profiles?.style?.visualTags.includes("shadow")) {
    hints.push("map shadow to local elevation token if present");
  }
  return Array.from(new Set(hints));
}

function componentLimitations(reference: CapturedUiReference, kind: CapturedUiComponentKind): string[] {
  const limitations: string[] = [];
  const element = reference.element;
  if (element.selectorConfidence === "low") {
    limitations.push("selector is structurally fragile");
  }
  if (reference.hitElement && reference.hitElement.selector !== element.selector) {
    limitations.push(`raw hit <${reference.hitElement.tagName}> was promoted to semantic <${element.tagName}>`);
  }
  if (kind === "unknown") {
    limitations.push("component kind could not be classified confidently");
  }
  if (!element.accessibleName && !element.ariaLabel && !element.textPreview && (kind === "button" || kind === "link" || kind === "input")) {
    limitations.push("interactive target has weak label context");
  }
  if (element.bounds.width <= 4 || element.bounds.height <= 4) {
    limitations.push("selected target has tiny bounds");
  }
  if (reference.profiles?.accessibility?.issues.length) {
    limitations.push(...reference.profiles.accessibility.issues.slice(0, 3));
  }
  return Array.from(new Set(limitations)).slice(0, 6);
}

function omitEmptyProfileSections(profile: CapturedUiStyleProfile): CapturedUiStyleProfile {
  return {
    typography: profile.typography && Object.keys(profile.typography).length ? profile.typography : undefined,
    colors: profile.colors && Object.keys(profile.colors).length ? profile.colors : undefined,
    spacing: profile.spacing && Object.keys(profile.spacing).length ? profile.spacing : undefined,
    shape: profile.shape && Object.keys(profile.shape).length ? profile.shape : undefined,
    layout: profile.layout && Object.keys(profile.layout).length ? profile.layout : undefined,
    visualTags: profile.visualTags
  };
}

function omitUndefinedValues<T extends Record<string, string | undefined>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && entry[1] !== "")) as Partial<T>;
}

function omitUndefinedBooleanValues<T extends Record<string, string | boolean | undefined>>(value: T): Partial<T> | undefined {
  const filtered = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && entry[1] !== "")) as Partial<T>;
  return Object.keys(filtered).length ? filtered : undefined;
}

function omitUndefinedComponentStructure(value: NonNullable<CapturedUiComponentIR["structure"]>): CapturedUiComponentIR["structure"] | undefined {
  const filtered = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as CapturedUiComponentIR["structure"];
  return filtered && Object.keys(filtered).length ? filtered : undefined;
}

function omitUndefinedAccessibilitySummary(value: NonNullable<CapturedUiComponentIR["accessibility"]>): CapturedUiComponentIR["accessibility"] | undefined {
  const filtered = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as CapturedUiComponentIR["accessibility"];
  return filtered && Object.keys(filtered).length ? filtered : undefined;
}

function omitUndefinedSourceHints(value: NonNullable<CapturedUiComponentIR["sourceHints"]>): CapturedUiComponentIR["sourceHints"] | undefined {
  const filtered = Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && (!Array.isArray(entry[1]) || entry[1].length > 0))) as CapturedUiComponentIR["sourceHints"];
  return filtered && Object.keys(filtered).length ? filtered : undefined;
}

function pruneEmptyValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map(pruneEmptyValues)
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (!value || typeof value !== "object") {
    return value === "" ? undefined : value;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [key, pruneEmptyValues(entryValue)] as const)
    .filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function styleVisualTags(style: CapturedUiStyleSummary): string[] {
  const tags: string[] = [];
  if (style.display === "flex" || style.display === "inline-flex") {
    tags.push("flex");
  } else if (style.display === "grid" || style.display === "inline-grid") {
    tags.push("grid");
  }
  if (!isTransparentColor(style.backgroundColor)) {
    tags.push("filled");
  }
  if (style.borderRadius && style.borderRadius !== "0px") {
    tags.push("rounded");
  }
  if (style.boxShadow && style.boxShadow !== "none") {
    tags.push("shadow");
  }
  if (style.border && !/^0px\s+none\b/.test(style.border)) {
    tags.push("bordered");
  }
  const weight = Number(style.fontWeight);
  if (Number.isFinite(weight) && weight >= 600) {
    tags.push("bold");
  }
  return tags.slice(0, 8);
}

function omitEmptyDisplayStyle(style: CapturedUiDisplaySummary["styleSummary"]): CapturedUiDisplaySummary["styleSummary"] | undefined {
  if (!style) {
    return undefined;
  }
  return Object.values(style).some(Boolean) ? style : undefined;
}

function shortFontFamily(value: string): string {
  return value.split(",")[0]?.replace(/^["']|["']$/g, "").trim() || "";
}

function compactCssColor(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const rgbMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/i.exec(trimmed);
  if (!rgbMatch) {
    return trimmed;
  }

  const alpha = rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4]);
  if (alpha === 0) {
    return "transparent";
  }

  const red = Number(rgbMatch[1]);
  const green = Number(rgbMatch[2]);
  const blue = Number(rgbMatch[3]);
  const hex = `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
  return alpha === 1 ? hex : `${hex} / ${alpha}`;
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function isTransparentColor(value: string): boolean {
  return value === "transparent" || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(value.trim());
}

function semanticContextForElement(element: CapturedUiElement): string | undefined {
  if (element.href) {
    return `Link target: ${pathOrDomainForHref(element.href)}`;
  }
  if (element.name) {
    return `Name: ${element.name}`;
  }
  if (element.type && (element.tagName === "button" || element.tagName === "input")) {
    return `Type: ${element.type}`;
  }
  return undefined;
}

function describeHitElement(hitElement: CapturedUiHitElement, element: CapturedUiElement): string {
  const insideSvg = hitElement.tagName === "path" || hitElement.tagName === "circle" || hitElement.tagName === "rect" ||
    hitElement.selector.includes("svg");
  const location = insideSvg ? " inside SVG" : "";
  return `<${hitElement.tagName}>${location}, promoted to <${element.tagName}>`;
}

function domainForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOrDomainForHref(href: string | undefined): string | undefined {
  if (!href) {
    return undefined;
  }
  try {
    const url = new URL(href, "https://capture.local");
    if (url.hostname === "capture.local") {
      return `${url.pathname}${url.search}${url.hash}` || href;
    }
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return href;
  }
}

