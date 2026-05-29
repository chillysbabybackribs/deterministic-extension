import type {
  PageActionOptions,
  PageActionTarget,
  PageCondition,
  PageConditionCheck,
  PageInteractionAction,
  PageInteractionResult,
  PageObservation,
  PageObservedElement
} from "./pageInteractionTypes";

export function collectPageObservation(options: { maxElements: number; includeInvisible: boolean }): PageObservation {
  const maxElements = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(options.maxElements)));
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[role]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const elements = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))
    .map(describeElement)
    .filter((element) => options.includeInvisible || element.visible)
    .slice(0, maxElements);
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const maxY = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
  const textSample = normalizeText(document.body?.innerText ?? "").slice(0, 1600);
  const warnings: string[] = [];
  if (window.frames.length) {
    warnings.push("Observation covers the top frame. Cross-origin frame contents are not included.");
  }
  if (elements.length >= maxElements) {
    warnings.push(`Observed elements were capped at ${maxElements}.`);
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      maxY: Math.round(maxY)
    },
    textSample,
    elements,
    frameCount: window.frames.length,
    warnings
  };

  function describeElement(element: Element): PageObservedElement {
    const htmlElement = element as HTMLElement;
    const input = element instanceof HTMLInputElement ? element : undefined;
    const select = element instanceof HTMLSelectElement ? element : undefined;
    const rect = htmlElement.getBoundingClientRect();
    const visible = isVisible(htmlElement, rect);
    const selector = buildCssSelector(htmlElement);
    const role = inferRole(element);
    const name = accessibleName(element);
    const text = normalizeText(htmlElement.innerText || htmlElement.textContent || "").slice(0, 220) || undefined;
    const label = associatedLabel(element);
    const type = input?.type || element.getAttribute("type") || undefined;
    const editable = isEditable(element);
    const disabled = Boolean(
      (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled ||
      element.getAttribute("aria-disabled") === "true"
    );
    const value = input && input.type !== "password" && input.type !== "file"
      ? input.value.slice(0, 160) || undefined
      : select
        ? select.value || undefined
        : element instanceof HTMLTextAreaElement
          ? element.value.slice(0, 160) || undefined
          : undefined;

    return {
      ref: `css:${selector}`,
      selector,
      tagName: element.tagName.toLowerCase(),
      role,
      name,
      text,
      label,
      placeholder: input?.placeholder || (element instanceof HTMLTextAreaElement ? element.placeholder : undefined) || undefined,
      type,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      value,
      checked: input && (input.type === "checkbox" || input.type === "radio") ? input.checked : undefined,
      disabled,
      editable,
      visible,
      required: (input ?? select ?? (element instanceof HTMLTextAreaElement ? element : undefined))?.required || undefined,
      bounds: visible
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        : undefined
    };
  }

  function isVisible(element: HTMLElement, rect = element.getBoundingClientRect()): boolean {
    const style = window.getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function inferRole(element: Element): string | undefined {
    const explicitRole = element.getAttribute("role");
    if (explicitRole) {
      return explicitRole.trim().split(/\s+/)[0];
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tag === "button" || tag === "summary") {
      return "button";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio" || type === "button" || type === "submit" || type === "reset") {
        return type === "button" || type === "submit" || type === "reset" ? "button" : type;
      }
      return "textbox";
    }
    if ((element as HTMLElement).isContentEditable) {
      return "textbox";
    }
    return undefined;
  }

  function accessibleName(element: Element): string | undefined {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel?.trim()) {
      return normalizeText(ariaLabel).slice(0, 220);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (text.trim()) {
        return normalizeText(text).slice(0, 220);
      }
    }
    const label = associatedLabel(element);
    if (label) {
      return label;
    }
    const title = element.getAttribute("title");
    if (title?.trim()) {
      return normalizeText(title).slice(0, 220);
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder?.trim()) {
      return normalizeText(placeholder).slice(0, 220);
    }
    if (element instanceof HTMLInputElement && /^(button|submit|reset)$/i.test(element.type) && element.value) {
      return normalizeText(element.value).slice(0, 220);
    }
    const text = normalizeText((element as HTMLElement).innerText || element.textContent || "");
    return text ? text.slice(0, 220) : undefined;
  }

  function associatedLabel(element: Element): string | undefined {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const labels = element.labels ? Array.from(element.labels).map((label) => label.textContent ?? "").join(" ") : "";
      if (labels.trim()) {
        return normalizeText(labels).slice(0, 220);
      }
    }
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)?.textContent;
      if (label?.trim()) {
        return normalizeText(label).slice(0, 220);
      }
    }
    const wrappingLabel = element.closest("label")?.textContent;
    return wrappingLabel?.trim() ? normalizeText(wrappingLabel).slice(0, 220) : undefined;
  }

  function isEditable(element: Element): boolean {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return !element.disabled;
    }
    if (element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly && !/^(button|submit|reset|checkbox|radio|file|hidden)$/i.test(element.type);
    }
    return (element as HTMLElement).isContentEditable;
  }

  function buildCssSelector(element: HTMLElement): string {
    if (element.id) {
      return `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
    }

    const attrSelector = selectorFromStableAttribute(element);
    if (attrSelector && document.querySelectorAll(attrSelector).length === 1) {
      return attrSelector;
    }

    const parts: string[] = [];
    let current: HTMLElement | null = element;
    while (current && current !== document.body && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const stable = selectorFromStableAttribute(current);
      const part = stable
        ? stable
        : `${tag}:nth-of-type(${nthOfType(current)})`;
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
      current = current.parentElement;
    }

    parts.unshift("body");
    return parts.join(" > ");
  }

  function selectorFromStableAttribute(element: Element): string | undefined {
    const tag = element.tagName.toLowerCase();
    for (const attr of ["data-testid", "data-test", "data-cy", "name", "aria-label", "title", "href"]) {
      const value = element.getAttribute(attr);
      if (value?.trim()) {
        return `${tag}[${attr}="${CSS.escape(value.trim())}"]`;
      }
    }
    return undefined;
  }

  function nthOfType(element: Element): number {
    const tag = element.tagName;
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === tag) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function normalizeText(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
}

export function runPageInteraction(
  action: PageInteractionAction,
  target: PageActionTarget,
  options: PageActionOptions
): PageInteractionResult {
  const warnings: string[] = [];
  let element: HTMLElement | undefined;

  if (action !== "scroll") {
    element = resolveTarget(target);
    if (!element) {
      throw new Error("No matching page element was found for the action target.");
    }
  } else if (target && hasTarget(target)) {
    element = resolveTarget(target);
    if (!element) {
      throw new Error("No matching page element was found for the scroll target.");
    }
  }

  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }

  if (action === "click") {
    ensureActionable(element);
    element.focus({ preventScroll: true });
    element.click();
  } else if (action === "type") {
    ensureActionable(element);
    typeIntoElement(element, String(options.text ?? ""), options.clear !== false);
  } else if (action === "select") {
    ensureActionable(element);
    selectOption(element, options);
  } else if (action === "press") {
    const key = String(options.key || "Enter");
    pressKey(element, key, warnings);
  } else if (action === "scroll") {
    scrollPageOrElement(element, options);
  } else {
    throw new Error(`Unsupported page action: ${action}`);
  }

  const described = element ? describeElement(element) : undefined;
  return {
    action,
    ok: true,
    message: described
      ? `${action} completed on ${described.name || described.text || described.selector}.`
      : `${action} completed.`,
    url: location.href,
    title: document.title,
    target: described,
    warnings
  };

  function resolveTarget(pageTarget: PageActionTarget): HTMLElement | undefined {
    // DETERMINISTIC PATH: an overlay index resolves to the exact node the badge
    // marked, via the stamp the overlay placed. Tried first because it is
    // unambiguous (no text/selector matching). Falls through to the heuristic
    // paths if the stamp is gone (e.g. the overlay was torn down or the DOM
    // re-rendered between observe and act).
    if (pageTarget.overlayIndex !== undefined) {
      const byIndex = document.querySelector<HTMLElement>(`[data-ohmygod-idx="${pageTarget.overlayIndex}"]`);
      if (byIndex) {
        return byIndex;
      }
    }

    const selector = selectorFromTarget(pageTarget);
    if (selector) {
      const bySelector = document.querySelector<HTMLElement>(selector);
      if (bySelector) {
        return bySelector;
      }
    }

    const candidates = Array.from(document.querySelectorAll<HTMLElement>([
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      "[contenteditable='']",
      "[role]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",")));
    const matches = candidates.filter((candidate) => targetMatches(candidate, pageTarget));
    const index = Math.max(0, Math.floor(pageTarget.index ?? 0));
    return matches[index];
  }

  function selectorFromTarget(pageTarget: PageActionTarget): string | undefined {
    const ref = pageTarget.elementRef?.trim();
    if (ref) {
      return ref.startsWith("css:") ? ref.slice(4) : ref;
    }
    return pageTarget.selector?.trim() || undefined;
  }

  function targetMatches(elementToCheck: HTMLElement, pageTarget: PageActionTarget): boolean {
    const haystack = [
      elementToCheck.getAttribute("role"),
      inferRole(elementToCheck),
      accessibleName(elementToCheck),
      associatedLabel(elementToCheck),
      elementToCheck.getAttribute("placeholder"),
      elementToCheck.innerText,
      elementToCheck.textContent,
      elementToCheck.getAttribute("href"),
      elementToCheck.getAttribute("name")
    ].filter(Boolean).join(" ").toLowerCase();

    if (pageTarget.role && inferRole(elementToCheck) !== pageTarget.role.toLowerCase()) {
      return false;
    }
    for (const value of [pageTarget.text, pageTarget.name, pageTarget.label, pageTarget.placeholder]) {
      if (value && !haystack.includes(value.toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  function ensureActionable(actionElement: HTMLElement | undefined): asserts actionElement is HTMLElement {
    if (!actionElement) {
      throw new Error("No page element is selected.");
    }
    const disabled = Boolean(
      (actionElement as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled ||
      actionElement.getAttribute("aria-disabled") === "true"
    );
    if (disabled) {
      throw new Error("The selected element is disabled.");
    }
  }

  function typeIntoElement(actionElement: HTMLElement, text: string, clear: boolean): void {
    if (actionElement instanceof HTMLInputElement) {
      if (actionElement.type === "file") {
        throw new Error("Typing into file inputs is not supported.");
      }
      if (actionElement.type === "password") {
        throw new Error("Refusing to type into password inputs through deterministic tools.");
      }
      if (actionElement.readOnly) {
        throw new Error("The selected input is read-only.");
      }
      setInputValue(actionElement, clear ? text : `${actionElement.value}${text}`);
      return;
    }
    if (actionElement instanceof HTMLTextAreaElement) {
      if (actionElement.readOnly) {
        throw new Error("The selected textarea is read-only.");
      }
      setTextAreaValue(actionElement, clear ? text : `${actionElement.value}${text}`);
      return;
    }
    if (actionElement.isContentEditable) {
      actionElement.focus();
      if (clear) {
        actionElement.textContent = "";
      }
      actionElement.textContent = `${actionElement.textContent ?? ""}${text}`;
      dispatchInputEvents(actionElement);
      return;
    }
    throw new Error("The selected element is not editable.");
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    dispatchInputEvents(input);
  }

  function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    dispatchInputEvents(textarea);
  }

  function dispatchInputEvents(actionElement: HTMLElement): void {
    actionElement.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    actionElement.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectOption(actionElement: HTMLElement, selectOptions: PageActionOptions): void {
    const select = actionElement instanceof HTMLSelectElement
      ? actionElement
      : actionElement.querySelector("select");
    if (!select) {
      throw new Error("The selected element is not a select control.");
    }

    const value = selectOptions.value;
    const optionText = selectOptions.optionText;
    const option = Array.from(select.options).find((candidate) =>
      value !== undefined
        ? candidate.value === value
        : optionText !== undefined && normalizeText(candidate.textContent ?? candidate.value).toLowerCase().includes(optionText.toLowerCase())
    );
    if (!option) {
      throw new Error("No matching option was found.");
    }

    select.focus();
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressKey(actionElement: HTMLElement | undefined, key: string, pressWarnings: string[]): void {
    const eventTarget = actionElement ?? document.activeElement as HTMLElement | null ?? document.body;
    eventTarget.focus?.({ preventScroll: true });
    const keyOptions = { key, bubbles: true, cancelable: true };
    const keydown = new KeyboardEvent("keydown", keyOptions);
    eventTarget.dispatchEvent(keydown);
    if (!keydown.defaultPrevented) {
      if ((key === "Enter" || key === " ") && actionElement && shouldActivateForKey(actionElement)) {
        actionElement.click();
      } else if (key === "Enter" && actionElement instanceof HTMLInputElement && actionElement.form) {
        actionElement.form.requestSubmit();
      } else {
        pressWarnings.push("Synthetic key events may not trigger all browser-default behavior on every site.");
      }
    }
    eventTarget.dispatchEvent(new KeyboardEvent("keyup", keyOptions));
  }

  function shouldActivateForKey(actionElement: HTMLElement): boolean {
    const role = inferRole(actionElement);
    return role === "button" ||
      role === "link" ||
      actionElement instanceof HTMLButtonElement ||
      actionElement instanceof HTMLAnchorElement;
  }

  function scrollPageOrElement(scrollElement: HTMLElement | undefined, scrollOptions: PageActionOptions): void {
    const direction = scrollOptions.direction ?? "down";
    const amount = Math.max(1, Math.round(scrollOptions.amount ?? Math.floor(window.innerHeight * 0.8)));
    if (scrollElement) {
      scrollElement.scrollIntoView({ block: direction === "up" ? "start" : "center", inline: "nearest", behavior: "auto" });
      return;
    }
    if (direction === "top") {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    if (direction === "bottom") {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      return;
    }
    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
    window.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
  }

  function hasTarget(pageTarget: PageActionTarget): boolean {
    return Boolean(pageTarget.elementRef || pageTarget.selector || pageTarget.text || pageTarget.role || pageTarget.name || pageTarget.label || pageTarget.placeholder);
  }

  function describeElement(actionElement: HTMLElement): PageObservedElement {
    const rect = actionElement.getBoundingClientRect();
    const selector = buildCssSelector(actionElement);
    const input = actionElement instanceof HTMLInputElement ? actionElement : undefined;
    return {
      ref: `css:${selector}`,
      selector,
      tagName: actionElement.tagName.toLowerCase(),
      role: inferRole(actionElement),
      name: accessibleName(actionElement),
      text: normalizeText(actionElement.innerText || actionElement.textContent || "").slice(0, 220) || undefined,
      label: associatedLabel(actionElement),
      placeholder: input?.placeholder || (actionElement instanceof HTMLTextAreaElement ? actionElement.placeholder : undefined) || undefined,
      type: input?.type || actionElement.getAttribute("type") || undefined,
      href: actionElement instanceof HTMLAnchorElement ? actionElement.href : undefined,
      value: input && input.type !== "password" && input.type !== "file" ? input.value.slice(0, 160) || undefined : undefined,
      checked: input && (input.type === "checkbox" || input.type === "radio") ? input.checked : undefined,
      disabled: Boolean((actionElement as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
      editable: actionElement.isContentEditable || actionElement instanceof HTMLInputElement || actionElement instanceof HTMLTextAreaElement || actionElement instanceof HTMLSelectElement,
      visible: rect.width > 0 && rect.height > 0 && window.getComputedStyle(actionElement).visibility !== "hidden",
      required: input?.required || undefined,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function inferRole(actionElement: Element): string | undefined {
    const explicitRole = actionElement.getAttribute("role");
    if (explicitRole) {
      return explicitRole.trim().split(/\s+/)[0].toLowerCase();
    }
    const tag = actionElement.tagName.toLowerCase();
    if (tag === "a" && actionElement.hasAttribute("href")) {
      return "link";
    }
    if (tag === "button" || tag === "summary") {
      return "button";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "input") {
      const type = (actionElement.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return type;
      }
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      return "textbox";
    }
    if ((actionElement as HTMLElement).isContentEditable) {
      return "textbox";
    }
    return undefined;
  }

  function accessibleName(actionElement: Element): string | undefined {
    const ariaLabel = actionElement.getAttribute("aria-label");
    if (ariaLabel?.trim()) {
      return normalizeText(ariaLabel).slice(0, 220);
    }
    const label = associatedLabel(actionElement);
    if (label) {
      return label;
    }
    const placeholder = actionElement.getAttribute("placeholder");
    if (placeholder?.trim()) {
      return normalizeText(placeholder).slice(0, 220);
    }
    const text = normalizeText((actionElement as HTMLElement).innerText || actionElement.textContent || "");
    return text ? text.slice(0, 220) : undefined;
  }

  function associatedLabel(actionElement: Element): string | undefined {
    if (actionElement instanceof HTMLInputElement || actionElement instanceof HTMLTextAreaElement || actionElement instanceof HTMLSelectElement) {
      const labels = actionElement.labels ? Array.from(actionElement.labels).map((label) => label.textContent ?? "").join(" ") : "";
      if (labels.trim()) {
        return normalizeText(labels).slice(0, 220);
      }
    }
    const id = actionElement.getAttribute("id");
    if (id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)?.textContent;
      if (label?.trim()) {
        return normalizeText(label).slice(0, 220);
      }
    }
    return undefined;
  }

  function buildCssSelector(actionElement: HTMLElement): string {
    if (actionElement.id) {
      return `${actionElement.tagName.toLowerCase()}#${CSS.escape(actionElement.id)}`;
    }
    const name = actionElement.getAttribute("name");
    if (name) {
      const selector = `${actionElement.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
    const parts: string[] = [];
    let current: HTMLElement | null = actionElement;
    while (current && current !== document.body && current !== document.documentElement) {
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${nthOfType(current)})`);
      const selector = parts.join(" > ");
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
      current = current.parentElement;
    }
    parts.unshift("body");
    return parts.join(" > ");
  }

  function nthOfType(actionElement: Element): number {
    const tag = actionElement.tagName;
    let index = 1;
    let sibling = actionElement.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === tag) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function normalizeText(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
}

export function checkConditionInPage(condition: PageCondition): PageConditionCheck {
  const selector = condition.selector;
  const element = selector ? document.querySelector<HTMLElement>(selector) : undefined;
  const elementVisible = element ? isVisible(element) : false;
  const state = condition.elementState ?? (selector ? "visible" : undefined);
  const selectorMatched = selector
    ? state === "absent"
      ? !element
      : state === "hidden"
        ? Boolean(element && !elementVisible)
        : state === "present"
          ? Boolean(element)
          : Boolean(element && elementVisible)
    : undefined;
  const normalizedText = normalizeText(document.body?.innerText ?? "");
  const textMatched = condition.text
    ? normalizedText.toLowerCase().includes(condition.text.toLowerCase())
    : undefined;
  const urlMatched = condition.urlIncludes
    ? location.href.toLowerCase().includes(condition.urlIncludes.toLowerCase())
    : undefined;
  const titleMatched = condition.titleIncludes
    ? document.title.toLowerCase().includes(condition.titleIncludes.toLowerCase())
    : undefined;
  const checks = [selectorMatched, textMatched, urlMatched, titleMatched]
    .filter((value): value is boolean => typeof value === "boolean");

  return {
    condition,
    satisfied: checks.length > 0 && checks.every(Boolean),
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    selectorMatched,
    textMatched,
    urlMatched,
    titleMatched,
    elementVisible: element ? elementVisible : undefined,
    textSample: normalizedText.slice(0, 1200)
  };

  function isVisible(candidate: HTMLElement): boolean {
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function normalizeText(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
}
