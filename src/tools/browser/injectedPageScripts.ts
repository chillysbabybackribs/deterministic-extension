import type {
  ImageSearchPageResult,
  ImageSearchResult,
  PageAppDomNode,
  PageAppInspection,
  PageAppInspectionOptions,
  PageExplorationDiff,
  PageExplorationEvent,
  PageExplorationMiniSnapshot,
  PageExplorationScriptResult,
  PageExplorationTarget
} from "../browserToolExecutor";

export async function collectImageSearchResultsInPage(minImages: number): Promise<ImageSearchPageResult> {
  const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const collect = (): ImageSearchResult[] => {
    const seen = new Set<string>();
    const candidates: ImageSearchResult[] = [];
    const imageElements = Array.from(document.querySelectorAll("img"));

    for (const img of imageElements) {
      const image = img as HTMLImageElement;
      const box = image.getBoundingClientRect();
      const thumbnailUrl = image.currentSrc || image.src;
      if (!thumbnailUrl || box.width < 48 || box.height < 48) {
        continue;
      }

      const anchor = image.closest("a[href]") as HTMLAnchorElement | null;
      const pageUrl = anchor?.href;
      const dedupeKey = pageUrl || thumbnailUrl;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const title = image.alt ||
        anchor?.getAttribute("aria-label") ||
        anchor?.textContent?.replace(/\s+/g, " ").trim() ||
        "Image result";
      const source = pageUrl
        ? (() => {
            try {
              return new URL(pageUrl).hostname.replace(/^www\./, "");
            } catch {
              return undefined;
            }
          })()
        : undefined;

      candidates.push({
        index: candidates.length + 1,
        title,
        source,
        pageUrl,
        thumbnailUrl
      });

      if (candidates.length >= Math.max(minImages, 24)) {
        break;
      }
    }

    return candidates;
  };

  let images = collect();
  for (let attempt = 0; images.length < minImages && attempt < 8; attempt += 1) {
    window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 500), behavior: "auto" });
    await pause(450);
    images = collect();
  }

  window.scrollTo({ top: 0, behavior: "auto" });

  return {
    url: window.location.href,
    title: document.title,
    imageCount: images.length,
    images
  };
}

export async function runSafePageExplorationInPage(): Promise<PageExplorationScriptResult> {
  const events: PageExplorationEvent[] = [];
  const skippedRiskyTargets: PageExplorationTarget[] = [];
  const warnings: string[] = [];
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const nextPaint = () => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
  const visible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    return element.getClientRects().length > 0;
  };
  const labelFor = (element: Element): string | undefined => {
    const aria = element.getAttribute("aria-label");
    if (aria) {
      return clean(aria);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .map(clean)
        .join(" ");
      if (text) {
        return text;
      }
    }
    const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const labels = "labels" in control && control.labels
      ? Array.from(control.labels).map((label) => clean(label.textContent)).filter(Boolean)
      : [];
    if (labels.length) {
      return labels.join(" ");
    }
    return clean((element as HTMLElement).innerText || element.textContent || element.getAttribute("title") || element.getAttribute("alt"));
  };
  const roleOf = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") {
      return "button";
    }
    if (tag === "summary") {
      return "summary";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "a" && (element as HTMLAnchorElement).href) {
      return "link";
    }
    if (tag === "input") {
      const type = ((element as HTMLInputElement).type || "text").toLowerCase();
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (type === "submit" || type === "button" || type === "reset") {
        return "button";
      }
      return "textbox";
    }
    return undefined;
  };
  const selectorHintFor = (element: Element): string | undefined => {
    const escape = (value: string) => {
      const css = window.CSS as typeof CSS | undefined;
      return css?.escape ? css.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const id = element.getAttribute("id");
    if (id) {
      return `#${escape(id)}`;
    }
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy");
    if (testId) {
      return `[data-testid="${testId.replace(/"/g, "\\\"")}"]`;
    }
    return element.tagName.toLowerCase();
  };
  const targetFor = (element: Element): PageExplorationTarget => ({
    tagName: element.tagName.toLowerCase(),
    role: roleOf(element),
    type: element.getAttribute("type") || undefined,
    name: element.getAttribute("name") || labelFor(element),
    text: clean((element as HTMLElement).innerText || element.textContent),
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    selectorHint: selectorHintFor(element)
  });
  const snapshot = (): PageExplorationMiniSnapshot => {
    const controlSelector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "details",
      "[role]",
      "[aria-haspopup]",
      "[aria-expanded]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const storageKeys = (name: "localStorage" | "sessionStorage") => {
      try {
        const area = window[name];
        return Array.from({ length: area.length }, (_, index) => area.key(index)).filter((key): key is string => Boolean(key));
      } catch {
        return [];
      }
    };
    return {
      url: location.href,
      title: document.title,
      scrollY: window.scrollY,
      maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      visibleText: clean(document.body?.innerText || document.documentElement.textContent),
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
        .map((heading) => clean(heading.textContent))
        .filter(Boolean),
      controls: Array.from(document.querySelectorAll(controlSelector))
        .filter(visible)
        .map(targetFor),
      resourceCount: performance.getEntriesByType("resource").length,
      storageKeys: {
        localStorage: storageKeys("localStorage"),
        sessionStorage: storageKeys("sessionStorage")
      }
    };
  };
  const diffSnapshots = (before: PageExplorationMiniSnapshot, after: PageExplorationMiniSnapshot): PageExplorationDiff => {
    const beforeHeadings = new Set(before.headings);
    const beforeControls = new Set(before.controls.map((control) =>
      [control.role || control.tagName, control.name || control.text || control.href].filter(Boolean).join(": ")
    ));
    const beforeLocalKeys = new Set(before.storageKeys.localStorage);
    const beforeSessionKeys = new Set(before.storageKeys.sessionStorage);
    return {
      urlChanged: before.url !== after.url,
      newHeadings: after.headings.filter((heading) => !beforeHeadings.has(heading)),
      newControls: after.controls
        .map((control) => [control.role || control.tagName, control.name || control.text || control.href].filter(Boolean).join(": "))
        .filter((control) => control && !beforeControls.has(control)),
      newResourceCount: Math.max(0, after.resourceCount - before.resourceCount),
      newStorageKeys: {
        localStorage: after.storageKeys.localStorage.filter((key) => !beforeLocalKeys.has(key)),
        sessionStorage: after.storageKeys.sessionStorage.filter((key) => !beforeSessionKeys.has(key))
      },
      visibleTextChanged: before.visibleText !== after.visibleText
    };
  };
  const riskyTextPattern = /\b(transfer|submit|send|upload|file|folder|pay|buy|purchase|delete|remove|sign|continue|confirm|checkout|subscribe|upgrade|trial|request files?|download|share|invite|log\s*out|logout|save|apply|create|post|publish|accept|agree)\b/i;
  const safeTextPattern = /\b(menu|more|options|dropdown|expand|collapse|show|hide|filter|sort|tab|settings|account|profile|help|info|learn|details|toggle|open|close)\b/i;
  const classify = (element: Element): "safe" | "risky" | "skip" => {
    const target = targetFor(element);
    const tag = target.tagName;
    const type = (target.type || "").toLowerCase();
    const text = [target.name, target.text, target.role, target.selectorHint].filter(Boolean).join(" ");
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      type === "file" ||
      type === "submit" ||
      type === "password" ||
      (element as HTMLButtonElement | HTMLInputElement).disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      riskyTextPattern.test(text)
    ) {
      return "risky";
    }
    if (tag === "summary" || tag === "details") {
      return "safe";
    }
    if (element.getAttribute("aria-expanded") !== null || element.getAttribute("aria-haspopup") !== null) {
      return "safe";
    }
    const role = (target.role || "").toLowerCase();
    if (role === "tab" || role === "menuitem" || role === "button" || role === "switch") {
      return safeTextPattern.test(text) ? "safe" : "skip";
    }
    if (tag === "button") {
      return safeTextPattern.test(text) ? "safe" : "skip";
    }
    if (tag === "a") {
      const href = target.href || "";
      return href.includes("#") && safeTextPattern.test(text) ? "safe" : "skip";
    }
    return "skip";
  };

  const initial = snapshot();
  events.push({
    kind: "snapshot",
    label: "Initial page state before exploration",
    after: initial
  });

  const originalScroll = {
    x: window.scrollX,
    y: window.scrollY
  };

  try {
    window.scrollTo({ top: 0, behavior: "auto" });
    await nextPaint();
    let previousY = -1;
    while (window.scrollY !== previousY) {
      const before = snapshot();
      previousY = window.scrollY;
      const viewportStep = window.innerHeight || document.documentElement.clientHeight || document.body?.clientHeight || 1;
      window.scrollBy({ top: viewportStep, behavior: "auto" });
      await nextPaint();
      const after = snapshot();
      if (after.scrollY === before.scrollY) {
        break;
      }
      events.push({
        kind: "scroll",
        label: "Scrolled to reveal additional page content",
        detail: `scrollY ${before.scrollY} -> ${after.scrollY}`,
        before,
        after,
        diff: diffSnapshots(before, after)
      });
    }

    window.scrollTo({ top: originalScroll.y, left: originalScroll.x, behavior: "auto" });
    await nextPaint();

    const interactionSelector = [
      "summary",
      "details",
      "button",
      "a[href]",
      "[role='button']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='switch']",
      "[aria-expanded]",
      "[aria-haspopup]"
    ].join(",");
    const candidates = Array.from(document.querySelectorAll(interactionSelector));
    const seenTargets = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.isConnected || !visible(candidate)) {
        continue;
      }
      const target = targetFor(candidate);
      const signature = JSON.stringify(target);
      if (seenTargets.has(signature)) {
        continue;
      }
      seenTargets.add(signature);

      const classification = classify(candidate);
      if (classification === "risky") {
        skippedRiskyTargets.push(target);
        events.push({
          kind: "skipped_risky",
          label: "Skipped risky or mutating target",
          target,
          detail: "Requires explicit user approval before interaction."
        });
        continue;
      }
      if (classification !== "safe") {
        continue;
      }

      const before = snapshot();
      try {
        (candidate as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
        await nextPaint();
        if (candidate.tagName.toLowerCase() === "details") {
          (candidate as HTMLDetailsElement).open = true;
        } else {
          (candidate as HTMLElement).click();
        }
        await nextPaint();
        const after = snapshot();
        events.push({
          kind: "safe_interaction",
          label: "Safely interacted with non-destructive control",
          target,
          before,
          after,
          diff: diffSnapshots(before, after)
        });
      } catch (error) {
        const warning = `Safe interaction failed for ${target.selectorHint || target.text || target.name || target.tagName}: ${error instanceof Error ? error.message : "unknown error"}.`;
        warnings.push(warning);
        events.push({
          kind: "warning",
          label: "Safe interaction failed",
          target,
          warning
        });
      }
    }
  } catch (error) {
    const warning = `Page exploration interrupted: ${error instanceof Error ? error.message : "unknown error"}.`;
    warnings.push(warning);
    events.push({
      kind: "warning",
      label: "Page exploration interrupted",
      warning
    });
  }

  const finalSnapshot = snapshot();
  events.push({
    kind: "snapshot",
    label: "Final page state after exploration",
    after: finalSnapshot,
    diff: diffSnapshots(initial, finalSnapshot)
  });

  return {
    url: location.href,
    title: document.title,
    events,
    skippedRiskyTargets,
    warnings
  };
}

export async function collectPageAppInspectionInPage(options: PageAppInspectionOptions): Promise<PageAppInspection> {
  const warnings: string[] = [];
  const textLimit = options.maxTextChars;
  const take = <T>(items: T[], max: number): T[] => items.slice(0, Math.max(0, max));
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const clip = (value: unknown, max = textLimit): string => {
    const text = clean(value);
    return text.length > max ? `${text.slice(0, Math.max(0, max - 15))}...[truncated]` : text;
  };
  const attribute = (element: Element, name: string): string | undefined => {
    const value = element.getAttribute(name);
    return value ? clip(value) : undefined;
  };
  const visible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || element.getClientRects().length > 0;
  };
  const labelFor = (element: Element): string | undefined => {
    const labelledBy = attribute(element, "aria-labelledby");
    if (labelledBy) {
      const labelledText = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .map((value) => clean(value))
        .join(" ");
      if (labelledText) {
        return clip(labelledText);
      }
    }

    const aria = attribute(element, "aria-label");
    if (aria) {
      return aria;
    }

    const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const labels = "labels" in control && control.labels
      ? Array.from(control.labels).map((label) => clean(label.textContent)).filter(Boolean)
      : [];
    if (labels.length) {
      return clip(labels.join(" "));
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      const wrapped = clean(wrappingLabel.textContent);
      if (wrapped) {
        return clip(wrapped);
      }
    }

    return attribute(element, "title") ?? attribute(element, "alt");
  };
  const elementName = (element: Element): string | undefined => {
    const label = labelFor(element);
    if (label) {
      return label;
    }
    const text = clean((element as HTMLElement).innerText || element.textContent);
    return text ? clip(text) : undefined;
  };
  const implicitRole = (element: Element): string | undefined => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && (element as HTMLAnchorElement).href) {
      return "link";
    }
    if (tagName === "button") {
      return "button";
    }
    if (tagName === "select") {
      return "combobox";
    }
    if (tagName === "textarea") {
      return "textbox";
    }
    if (tagName === "input") {
      const type = ((element as HTMLInputElement).type || "text").toLowerCase();
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (type === "submit" || type === "button" || type === "reset") {
        return "button";
      }
      return "textbox";
    }
    if (tagName === "nav") {
      return "navigation";
    }
    if (tagName === "main") {
      return "main";
    }
    if (tagName === "aside") {
      return "complementary";
    }
    if (tagName === "header") {
      return "banner";
    }
    if (tagName === "footer") {
      return "contentinfo";
    }
    if (tagName === "form") {
      return "form";
    }
    if (tagName === "dialog") {
      return "dialog";
    }
    return undefined;
  };
  const roleOf = (element: Element): string | undefined => attribute(element, "role") ?? implicitRole(element);
  const tagCounts: Record<string, number> = {};
  const allElements = Array.from(document.querySelectorAll("*"));
  for (const element of allElements) {
    const tag = element.tagName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }

  const headings = take(Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading) => ({
    level: Number(heading.tagName.slice(1)),
    text: clip(heading.textContent),
    id: attribute(heading, "id")
  })).filter((heading) => heading.text), options.maxDomNodes);

  const landmarkSelector = "main,nav,header,footer,aside,section,article,form,dialog,[role]";
  const landmarks = take(Array.from(document.querySelectorAll(landmarkSelector)).map((element) => ({
    tagName: element.tagName.toLowerCase(),
    role: roleOf(element),
    id: attribute(element, "id"),
    name: elementName(element),
    text: clip((element as HTMLElement).innerText || element.textContent)
  })), options.maxDomNodes);

  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "details",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='option']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const interactiveElements = take(Array.from(document.querySelectorAll(interactiveSelector)).map((element) => {
    const htmlElement = element as HTMLElement;
    return {
      tagName: element.tagName.toLowerCase(),
      role: roleOf(element),
      type: attribute(element, "type"),
      id: attribute(element, "id"),
      name: attribute(element, "name") ?? elementName(element),
      text: clip(htmlElement.innerText || element.textContent),
      label: labelFor(element),
      href: element instanceof HTMLAnchorElement ? clip(element.href, textLimit) : undefined,
      disabled: Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled || element.getAttribute("aria-disabled") === "true"),
      visible: visible(element)
    };
  }), options.maxDomNodes);

  const forms = take(Array.from(document.forms).map((form, index) => {
    const fields = take(Array.from(form.elements).map((field) => {
      const element = field as Element;
      return {
        tagName: element.tagName.toLowerCase(),
        type: attribute(element, "type"),
        name: attribute(element, "name"),
        id: attribute(element, "id"),
        label: labelFor(element),
        placeholder: attribute(element, "placeholder"),
        required: Boolean((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).required),
        disabled: Boolean((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled)
      };
    }), options.maxDomNodes);
    const submitTexts = fields.length
      ? Array.from(form.querySelectorAll("button,input[type='submit'],input[type='button']"))
          .map((element) => elementName(element) ?? attribute(element, "value"))
          .filter((value): value is string => Boolean(value))
      : [];
    return {
      index,
      id: attribute(form, "id"),
      name: attribute(form, "name"),
      action: form.action ? clip(form.action, textLimit) : undefined,
      method: form.method ? form.method.toUpperCase() : undefined,
      fieldCount: form.elements.length,
      submitTexts: take(submitTexts, options.maxDomNodes),
      fields
    };
  }), options.maxDomNodes);

  const interestingTags = new Set([
    "main",
    "nav",
    "header",
    "footer",
    "aside",
    "section",
    "article",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "a",
    "dialog",
    "details",
    "summary",
    "table",
    "canvas",
    "svg",
    "video",
    "audio"
  ]);
  let domNodeCount = 0;
  const isInterestingNode = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    const classText = Array.from(element.classList).join(" ").toLowerCase();
    return interestingTags.has(tag) ||
      Boolean(roleOf(element)) ||
      Boolean(attribute(element, "aria-label")) ||
      Boolean(attribute(element, "data-testid") || attribute(element, "data-test") || attribute(element, "data-cy")) ||
      /\b(app|root|layout|route|page|view|modal|dialog|drawer|sidebar|panel|menu|nav|toolbar|content|chart|table|grid|form|search|filter)\b/.test(classText);
  };
  const elementAttributes = (element: Element): Record<string, string> | undefined => {
    const attrs: Record<string, string> = {};
    for (const name of ["data-testid", "data-test", "data-cy", "aria-label", "href", "type", "name", "placeholder"]) {
      const value = attribute(element, name);
      if (value) {
        attrs[name] = value;
      }
    }
    return Object.keys(attrs).length ? attrs : undefined;
  };
  const buildDomTree = (element: Element, depth: number): PageAppDomNode | undefined => {
    if (domNodeCount >= options.maxDomNodes || depth > options.maxTreeDepth) {
      return undefined;
    }

    const childNodes: PageAppDomNode[] = [];
    if (depth < options.maxTreeDepth) {
      for (const child of Array.from(element.children)) {
        if (domNodeCount >= options.maxDomNodes) {
          break;
        }
        const childNode = buildDomTree(child, depth + 1);
        if (childNode) {
          childNodes.push(childNode);
        }
      }
    }

    const include = depth === 0 || isInterestingNode(element) || childNodes.length > 0;
    if (!include) {
      return undefined;
    }

    domNodeCount += 1;
    const classes = Array.from(element.classList).map((className) => clip(className)).filter(Boolean);
    return {
      tagName: element.tagName.toLowerCase(),
      id: attribute(element, "id"),
      classes: classes.length ? classes : undefined,
      role: roleOf(element),
      name: elementName(element),
      text: childNodes.length ? undefined : clip((element as HTMLElement).innerText || element.textContent),
      attributes: elementAttributes(element),
      visible: visible(element),
      childElementCount: element.children.length,
      children: childNodes.length ? childNodes : undefined
    };
  };

  const scriptElements = Array.from(document.scripts);
  const externalScripts = take(scriptElements.filter((script) => script.src).map((script) => ({
    src: clip(script.src, textLimit),
    type: script.type || undefined,
    async: script.async,
    defer: script.defer
  })), options.maxDomNodes);
  const styleSheets = Array.from(document.styleSheets);
  const externalStyles: Array<{ href: string; media?: string }> = take(styleSheets
    .flatMap((sheet) => {
      const owner = sheet.ownerNode as Element | null;
      const href = "href" in sheet && sheet.href ? sheet.href : owner?.getAttribute("href");
      return href
        ? [{
            href: clip(href, textLimit),
            media: "media" in sheet && sheet.media ? String(sheet.media) : undefined
          }]
        : [];
    }), options.maxDomNodes);

  const globalWindow = window as unknown as Window & Record<string, unknown>;
  const scriptSrcs = externalScripts.map((script) => script.src.toLowerCase());
  const frameworkHints = [
    globalWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? "React devtools hook present" : undefined,
    document.querySelector("[data-reactroot], [data-reactid]") ? "React data attributes" : undefined,
    document.getElementById("__next") || scriptSrcs.some((src) => src.includes("/_next/")) ? "Next.js" : undefined,
    document.getElementById("__nuxt") || scriptSrcs.some((src) => src.includes("/_nuxt/")) ? "Nuxt" : undefined,
    globalWindow.__VUE__ || globalWindow.__VUE_DEVTOOLS_GLOBAL_HOOK__ ? "Vue devtools/global hook present" : undefined,
    document.querySelector("[ng-version]") || globalWindow.ng ? "Angular" : undefined,
    document.querySelector("[data-svelte-h]") ? "Svelte" : undefined,
    document.querySelector("astro-island") ? "Astro" : undefined,
    scriptSrcs.some((src) => src.includes("vite")) ? "Vite asset/client hint" : undefined,
    scriptSrcs.some((src) => src.includes("webpack") || src.includes("__webpack")) ? "Webpack asset hint" : undefined,
    scriptSrcs.some((src) => src.includes("shopify")) ? "Shopify asset hint" : undefined,
    document.querySelector("meta[name='generator'][content*='WordPress' i]") ? "WordPress generator meta" : undefined
  ].filter((hint): hint is string => Boolean(hint));

  let network: PageAppInspection["network"];
  if (options.includeNetwork) {
    const resourceEntries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .sort((a, b) => a.startTime - b.startTime);
    if (resourceEntries.length > options.maxResources) {
      warnings.push(`Resource timing contains ${resourceEntries.length} entries; returned the latest ${options.maxResources}.`);
    }
    const selectedResources = resourceEntries.slice(Math.max(0, resourceEntries.length - options.maxResources));
    const resourceCountsByType: Record<string, number> = {};
    const originCounts = new Map<string, number>();
    for (const entry of resourceEntries) {
      const type = entry.initiatorType || "resource";
      resourceCountsByType[type] = (resourceCountsByType[type] ?? 0) + 1;
      try {
        const parsed = new URL(entry.name, document.baseURI);
        originCounts.set(parsed.origin, (originCounts.get(parsed.origin) ?? 0) + 1);
      } catch {
        // Ignore non-URL resource names for origin grouping.
      }
    }
    const resourceToRecord = (entry: PerformanceResourceTiming) => {
      let origin: string | undefined;
      let path: string | undefined;
      let url = clip(entry.name, textLimit);
      try {
        const parsed = new URL(entry.name, document.baseURI);
        origin = parsed.origin;
        path = `${parsed.pathname}${parsed.search}`;
        url = clip(parsed.href, textLimit);
      } catch {
        // Keep the raw entry name when URL parsing is not possible.
      }
      const type = entry.initiatorType || "resource";
      return {
        url,
        origin,
        path: path ? clip(path, textLimit) : undefined,
        initiatorType: type,
        startTimeMs: Math.round(entry.startTime),
        durationMs: Math.round(entry.duration),
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize
      };
    };
    const allResourceRecords = resourceEntries.map(resourceToRecord);
    const resources = selectedResources.map(resourceToRecord);
    const apiLikeResources = take(allResourceRecords.filter((resource) =>
      /^(fetch|xmlhttprequest|beacon)$/i.test(resource.initiatorType ?? "") ||
      /\/(?:api|graphql|trpc|rpc|rest|v\d+)\b|[?&](?:query|operationName)=/i.test(resource.path ?? resource.url)
    ).map((resource) => ({
      url: resource.url,
      initiatorType: resource.initiatorType,
      startTimeMs: resource.startTimeMs,
      durationMs: resource.durationMs
    })), options.maxResources);
    const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    network = {
      navigation: navigationEntry
        ? {
            type: navigationEntry.type,
            durationMs: Math.round(navigationEntry.duration),
            domInteractiveMs: Math.round(navigationEntry.domInteractive),
            domContentLoadedMs: Math.round(navigationEntry.domContentLoadedEventEnd),
            loadEventEndMs: Math.round(navigationEntry.loadEventEnd),
            transferSize: navigationEntry.transferSize,
            encodedBodySize: navigationEntry.encodedBodySize,
            decodedBodySize: navigationEntry.decodedBodySize
          }
        : undefined,
      resourceCountsByType,
      resourceOrigins: Array.from(originCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([origin, count]) => ({ origin, count })),
      resources,
      apiLikeResources
    };
  }

  let storage: PageAppInspection["storage"];
  if (options.includeStorage) {
    const storageWarnings: string[] = [];
    const safeStorageArea = (name: "localStorage" | "sessionStorage"): Storage | undefined => {
      try {
        return window[name];
      } catch (error) {
        storageWarnings.push(`${name} could not be accessed: ${error instanceof Error ? error.message : "unknown error"}.`);
        return undefined;
      }
    };
    const readStorageArea = (area: Storage | undefined, label: string) => {
      if (!area) {
        return [];
      }
      try {
        const entries = [];
        for (let index = 0; index < area.length && entries.length < options.maxDomNodes; index += 1) {
          const key = area.key(index);
          if (!key) {
            continue;
          }
          const value = area.getItem(key) ?? "";
          entries.push({
            key: clip(key),
            valueLength: value.length,
            valueSample: options.includeStorageValues ? clip(value, textLimit) : undefined
          });
        }
        if (area.length > options.maxDomNodes) {
          storageWarnings.push(`${label} contains ${area.length} keys; returned ${options.maxDomNodes}.`);
        }
        return entries;
      } catch (error) {
        storageWarnings.push(`${label} could not be read: ${error instanceof Error ? error.message : "unknown error"}.`);
        return [];
      }
    };
    let cookieText = "";
    try {
      cookieText = document.cookie;
    } catch (error) {
      storageWarnings.push(`document.cookie could not be read: ${error instanceof Error ? error.message : "unknown error"}.`);
    }
    const cookieNames = cookieText
      ? take(cookieText.split(";").map((cookie) => clip(cookie.split("=")[0])).filter(Boolean), options.maxDomNodes)
      : [];
    let indexedDBDatabases: Array<{ name?: string; version?: number }> | undefined;
    const indexedDBApi = window.indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string; version?: number }>>;
    };
    if (indexedDBApi?.databases) {
      try {
        indexedDBDatabases = take((await indexedDBApi.databases()).map((database) => ({
          name: database.name ? clip(database.name) : undefined,
          version: database.version
        })), options.maxDomNodes);
      } catch (error) {
        storageWarnings.push(`IndexedDB database names could not be read: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
    }
    storage = {
      localStorage: readStorageArea(safeStorageArea("localStorage"), "localStorage"),
      sessionStorage: readStorageArea(safeStorageArea("sessionStorage"), "sessionStorage"),
      cookies: {
        count: cookieText ? cookieText.split(";").filter(Boolean).length : 0,
        names: cookieNames,
        valuesIncluded: false
      },
      indexedDB: indexedDBDatabases,
      warnings: storageWarnings
    };
    warnings.push(...storageWarnings);
  }

  const domTree = options.includeDomTree ? buildDomTree(document.body ?? document.documentElement, 0) : undefined;
  if (options.includeDomTree && domNodeCount >= options.maxDomNodes) {
    warnings.push(`DOM tree reached maxDomNodes (${options.maxDomNodes}). Increase maxDomNodes for a deeper tree.`);
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    language: document.documentElement.lang || undefined,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    },
    location: {
      origin: location.origin,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash
    },
    document: {
      doctype: document.doctype?.name,
      charset: document.characterSet,
      referrer: document.referrer || undefined,
      visibilityState: document.visibilityState,
      activeElement: document.activeElement
        ? [
            document.activeElement.tagName.toLowerCase(),
            attribute(document.activeElement, "id") ? `#${attribute(document.activeElement, "id")}` : "",
            attribute(document.activeElement, "name") ? `[name="${attribute(document.activeElement, "name")}"]` : ""
          ].join("")
        : undefined
    },
    frameworkHints,
    domSummary: {
      totalElements: allElements.length,
      byTag: tagCounts,
      headings,
      landmarks,
      forms,
      interactiveElements
    },
    domTree,
    network,
    scripts: options.includeScripts
      ? {
          external: externalScripts,
          inlineCount: scriptElements.filter((script) => !script.src).length,
          moduleCount: scriptElements.filter((script) => script.type === "module").length
        }
      : undefined,
    styles: options.includeStyles
      ? {
          external: externalStyles,
          inlineCount: document.querySelectorAll("style").length
        }
      : undefined,
    storage,
    warnings
  };
}
