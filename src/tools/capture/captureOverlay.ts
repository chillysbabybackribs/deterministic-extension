import type {
  CaptureScriptResult,
  CapturedUiAccessibilityProfile,
  CapturedUiAssetBackgroundImage,
  CapturedUiAssetImage,
  CapturedUiAssetProfile,
  CapturedUiAssetSvg,
  CapturedUiAssetVideo,
  CapturedUiBounds,
  CapturedUiCssVariableClue,
  CapturedUiElement,
  CapturedUiHitElement,
  CapturedUiLayoutContext,
  CapturedUiLayoutElementSummary,
  CapturedUiReference,
  CapturedUiSourceClues
} from "./capturedUiTypes";

export function runElementCaptureOverlay(cancelEventName: string): Promise<CaptureScriptResult> {
  return new Promise((resolve) => {
    const existing = document.getElementById("__ohmygod_ui_capture_overlay__");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "__ohmygod_ui_capture_overlay__";
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "2px solid #7aa2ff",
      borderRadius: "6px",
      boxShadow: "0 0 0 99999px rgb(10 14 25 / 14%), 0 0 0 3px rgb(122 162 255 / 24%)",
      background: "rgb(122 162 255 / 7%)",
      transition: "transform 45ms linear, width 45ms linear, height 45ms linear"
    });

    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      padding: "5px 7px",
      borderRadius: "6px",
      background: "rgb(16 18 24 / 94%)",
      color: "white",
      font: "12px/1.25 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 8px 24px rgb(0 0 0 / 28%)",
      transform: "translate(-9999px, -9999px)"
    });
    label.textContent = "Click to capture. Esc cancels.";

    document.documentElement.append(overlay, label);
    document.documentElement.style.cursor = "crosshair";

    let currentElement: Element | undefined;
    let currentHitElement: Element | undefined;
    let pendingPointer: { x: number; y: number } | undefined;
    let pointerFrame: number | undefined;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (pointerFrame !== undefined) {
        window.cancelAnimationFrame(pointerFrame);
        pointerFrame = undefined;
      }
      overlay.remove();
      label.remove();
      document.documentElement.style.cursor = "";
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerdown", suppressPointerEvent, true);
      window.removeEventListener("pointerup", suppressPointerEvent, true);
      window.removeEventListener("mousedown", suppressPointerEvent, true);
      window.removeEventListener("mouseup", suppressPointerEvent, true);
      window.removeEventListener("auxclick", suppressPointerEvent, true);
      window.removeEventListener("dblclick", suppressPointerEvent, true);
      window.removeEventListener("contextmenu", suppressPointerEvent, true);
      window.removeEventListener("click", handleClick, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener(cancelEventName, handleCancel, true);
    };

    const finish = (result: CaptureScriptResult) => {
      if (finished) {
        return;
      }

      cleanup();
      resolve(result);
    };

    const updateHighlight = (element: Element | undefined) => {
      currentElement = element;
      if (!element || !(element instanceof HTMLElement || element instanceof SVGElement)) {
        overlay.style.transform = "translate(-9999px, -9999px)";
        label.style.transform = "translate(-9999px, -9999px)";
        return;
      }

      const rect = element.getBoundingClientRect();
      overlay.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
      overlay.style.width = `${Math.round(rect.width)}px`;
      overlay.style.height = `${Math.round(rect.height)}px`;
      label.textContent = labelForElement(element);
      const labelTop = Math.max(4, Math.round(rect.top) - 30);
      const labelLeft = Math.min(window.innerWidth - 12, Math.max(4, Math.round(rect.left)));
      label.style.transform = `translate(${labelLeft}px, ${labelTop}px)`;
    };

    function handlePointerMove(event: PointerEvent) {
      suppressPointerEvent(event);
      pendingPointer = { x: event.clientX, y: event.clientY };
      if (pointerFrame !== undefined) {
        return;
      }
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = undefined;
        if (finished || !pendingPointer) {
          return;
        }
        const { x, y } = pendingPointer;
        pendingPointer = undefined;
        const element = hitElementAt(x, y);
        updateHighlight(element ? choosePrimaryElement(element) : undefined);
      });
    }

    function hitElementAt(clientX: number, clientY: number): Element | undefined {
      const element = document.elementFromPoint(clientX, clientY);
      currentHitElement = element && element !== overlay && element !== label ? element : undefined;
      return currentHitElement;
    }

    function suppressPointerEvent(event: Event) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    }

    function handleClick(event: MouseEvent) {
      suppressPointerEvent(event);
      const element = hitElementAt(event.clientX, event.clientY) ?? currentElement;
      if (!element || element === overlay || element === label) {
        return;
      }

      finish({
        status: "captured",
        capture: captureElement(element, event)
      });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      suppressPointerEvent(event);
      finish({ status: "cancelled" });
    }

    function handleCancel(event: Event) {
      suppressPointerEvent(event);
      finish({ status: "cancelled" });
    }

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerdown", suppressPointerEvent, true);
    window.addEventListener("pointerup", suppressPointerEvent, true);
    window.addEventListener("mousedown", suppressPointerEvent, true);
    window.addEventListener("mouseup", suppressPointerEvent, true);
    window.addEventListener("auxclick", suppressPointerEvent, true);
    window.addEventListener("dblclick", suppressPointerEvent, true);
    window.addEventListener("contextmenu", suppressPointerEvent, true);
    window.addEventListener("click", handleClick, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener(cancelEventName, handleCancel, true);
  });

  function captureElement(hitElement: Element, event: MouseEvent): CapturedUiReference {
    const primaryElement = choosePrimaryElement(hitElement);
    const primaryCapture = captureElementDetails(primaryElement);
    const hitCapture = primaryElement === hitElement ? undefined : captureHitElementDetails(hitElement);

    return {
      captureId: `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY)
      },
      pointer: {
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
        pageX: Math.round(event.pageX),
        pageY: Math.round(event.pageY)
      },
      element: primaryCapture,
      hitElement: hitCapture,
      profiles: {
        layoutContext: captureLayoutContext(primaryElement),
        assets: captureAssetProfile(primaryElement),
        accessibility: captureAccessibilityProfile(primaryElement, primaryCapture),
        sourceClues: captureSourceClues(primaryElement)
      }
    };
  }

  function captureElementDetails(element: Element): CapturedUiElement {
    const htmlElement = element as HTMLElement;
    const style = window.getComputedStyle(element);
    const selectorResult = buildCssSelector(element);
    const rect = element.getBoundingClientRect();
    const tagName = element.tagName.toLowerCase();
    const input = element instanceof HTMLInputElement ? element : undefined;
    const text = normalizeText(
      input && input.type !== "password" && input.type !== "file"
        ? input.value || input.placeholder || element.textContent || ""
        : (htmlElement.innerText || element.textContent || "")
    );
    const accessibleName = computeAccessibleName(element, text);
    const valuePreview = input && input.type !== "password" && input.type !== "file"
      ? normalizeText(input.value).slice(0, 120) || undefined
      : element instanceof HTMLTextAreaElement
        ? normalizeText(element.value).slice(0, 120) || undefined
        : undefined;

    const href = element instanceof HTMLAnchorElement && element.href
      ? clipAttributeValue(element.getAttribute("href") || element.href, 220)
      : undefined;
    const src = element instanceof HTMLImageElement && element.currentSrc
      ? clipAttributeValue(element.getAttribute("src") || element.currentSrc, 220)
      : undefined;

    return {
      selector: selectorResult.selector,
      selectorConfidence: selectorResult.confidence,
      tagName,
      id: element.id || undefined,
      classNames: Array.from(element.classList).slice(0, 20),
      textPreview: text ? text.slice(0, 260) : undefined,
      role: element.getAttribute("role") || inferredRole(element),
      ariaLabel: element.getAttribute("aria-label") || undefined,
      accessibleName,
      href,
      src,
      alt: element instanceof HTMLImageElement ? clipAttributeValue(element.alt, 160) || undefined : undefined,
      name: "name" in element ? clipAttributeValue(String((element as HTMLInputElement).name || ""), 120) || undefined : undefined,
      type: getElementType(element),
      placeholder: "placeholder" in element ? clipAttributeValue(String((element as HTMLInputElement).placeholder || ""), 160) || undefined : undefined,
      disabled: "disabled" in element ? Boolean((element as HTMLInputElement).disabled) : undefined,
      checked: "checked" in element ? Boolean((element as HTMLInputElement).checked) : undefined,
      valuePreview,
      dataAttributes: collectDataAttributes(element),
      bounds: elementBounds(rect),
      computedStyle: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        padding: boxValue(style, "padding"),
        margin: boxValue(style, "margin"),
        border: borderValue(style),
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow
      }
    };
  }

  function captureHitElementDetails(element: Element): CapturedUiHitElement {
    const details = captureElementDetails(element);
    return {
      selector: details.selector,
      selectorConfidence: details.selectorConfidence,
      tagName: details.tagName,
      id: details.id,
      classNames: details.classNames,
      textPreview: details.textPreview,
      role: details.role,
      ariaLabel: details.ariaLabel,
      accessibleName: details.accessibleName,
      href: details.href,
      src: details.src,
      alt: details.alt,
      name: details.name,
      type: details.type,
      placeholder: details.placeholder,
      disabled: details.disabled,
      checked: details.checked,
      valuePreview: details.valuePreview,
      dataAttributes: Object.keys(details.dataAttributes).length ? details.dataAttributes : undefined,
      bounds: details.bounds
    };
  }

  function captureLayoutContext(element: Element): CapturedUiLayoutContext {
    const parent = element.parentElement ? summarizeParentLayout(element.parentElement) : undefined;
    const siblings = element.parentElement
      ? Array.from(element.parentElement.children).filter((candidate) => candidate !== element && isVisibleLayoutElement(candidate))
      : [];
    const elementIndex = element.parentElement
      ? Array.from(element.parentElement.children).indexOf(element)
      : -1;
    const previousSiblings = element.parentElement && elementIndex >= 0
      ? Array.from(element.parentElement.children)
          .slice(Math.max(0, elementIndex - 3), elementIndex)
          .filter(isVisibleLayoutElement)
          .map(summarizeLayoutElement)
      : [];
    const nextSiblings = element.parentElement && elementIndex >= 0
      ? Array.from(element.parentElement.children)
          .slice(elementIndex + 1, elementIndex + 4)
          .filter(isVisibleLayoutElement)
          .map(summarizeLayoutElement)
      : [];
    const visibleChildren = Array.from(element.children).filter(isVisibleLayoutElement);

    return {
      parent,
      nearestSemanticContainer: findNearestSemanticContainer(element),
      previousSiblings,
      nextSiblings,
      children: visibleChildren.slice(0, 6).map(summarizeLayoutElement),
      childCount: visibleChildren.length,
      siblingCount: siblings.length
    };
  }

  function captureAssetProfile(element: Element): CapturedUiAssetProfile {
    const imageElements = uniqueElements([
      ...(element instanceof HTMLImageElement ? [element] : []),
      ...Array.from(element.querySelectorAll("img"))
    ]).slice(0, 5);
    const svgElements = uniqueElements([
      ...(element instanceof SVGSVGElement ? [element] : []),
      ...Array.from(element.querySelectorAll("svg"))
    ]).slice(0, 8);
    const videoElements = uniqueElements([
      ...(element instanceof HTMLVideoElement ? [element] : []),
      ...Array.from(element.querySelectorAll("video"))
    ]).slice(0, 2);

    return {
      images: imageElements.map(summarizeImageAsset),
      svgs: svgElements.map(summarizeSvgAsset),
      backgroundImages: collectBackgroundImageAssets(element),
      videos: videoElements.map(summarizeVideoAsset)
    };
  }

  function captureAccessibilityProfile(element: Element, captured: CapturedUiElement): CapturedUiAccessibilityProfile {
    const style = window.getComputedStyle(element);
    const foreground = compactCssColorInPage(style.color) || style.color;
    const background = effectiveBackgroundColor(element);
    const contrastRatio = contrastRatioForColors(style.color, background.raw);
    const focusable = isFocusableElement(element);
    const associatedLabel = associatedLabelForElement(element);
    const issues: string[] = [];

    if (isInteractiveElement(element) && !(captured.accessibleName || captured.ariaLabel || associatedLabel || captured.textPreview)) {
      issues.push("interactive element has no obvious accessible name");
    }
    if (contrastRatio !== undefined && contrastRatio < 4.5) {
      issues.push("text contrast may be below WCAG AA for normal text");
    }
    if (isInteractiveElement(element) && !focusable && !captured.disabled) {
      issues.push("interactive element may not be keyboard focusable");
    }

    return {
      role: captured.role,
      accessibleName: captured.accessibleName,
      ariaLabel: captured.ariaLabel,
      ariaLabelledBy: element.getAttribute("aria-labelledby") || undefined,
      associatedLabel,
      focusable,
      tabIndex: element instanceof HTMLElement && element.hasAttribute("tabindex") ? element.tabIndex : undefined,
      disabled: captured.disabled,
      required: "required" in element ? Boolean((element as HTMLInputElement).required) || undefined : undefined,
      contrast: contrastRatio === undefined ? undefined : {
        foreground,
        background: background.display,
        ratio: Math.round(contrastRatio * 100) / 100,
        passesAA: contrastRatio >= 4.5
      },
      issues: issues.slice(0, 5)
    };
  }

  function captureSourceClues(element: Element): CapturedUiSourceClues {
    return {
      documentLanguage: document.documentElement.lang || undefined,
      colorScheme: window.getComputedStyle(document.documentElement).colorScheme || undefined,
      metaGenerator: clipAttributeValue(document.querySelector<HTMLMetaElement>("meta[name=\"generator\"]")?.content || "", 120) || undefined,
      frameworkHints: detectFrameworkHints(),
      componentLibraryHints: detectComponentLibraryHints(element),
      cssFiles: collectCssFileClues(),
      fontFamilies: collectFontFamilyClues(element),
      cssVariables: collectCssVariableClues(element),
      scriptHints: collectScriptHints()
    };
  }

  function detectFrameworkHints(): string[] {
    const hints = new Set<string>();
    const html = document.documentElement;
    const body = document.body;
    const scripts = Array.from(document.scripts).map((script) => `${script.id} ${script.src}`).join(" ");

    if (document.getElementById("__next") || /\/_next\//i.test(scripts)) {
      hints.add("Next.js");
    }
    if (document.getElementById("__nuxt") || /\/_nuxt\//i.test(scripts)) {
      hints.add("Nuxt");
    }
    if (document.querySelector("[data-reactroot], [data-react-helmet]") || /react/i.test(scripts)) {
      hints.add("React");
    }
    if (html.hasAttribute("ng-version") || document.querySelector("[ng-version], [_nghost], [_ngcontent]")) {
      hints.add("Angular");
    }
    if (document.querySelector("[data-v-app], [v-cloak]") || /vue/i.test(scripts)) {
      hints.add("Vue");
    }
    if (document.querySelector("[data-svelte-h]") || /svelte/i.test(scripts)) {
      hints.add("Svelte");
    }
    if (document.querySelector("[data-astro-cid]") || /astro/i.test(scripts)) {
      hints.add("Astro");
    }
    if (document.querySelector("#___gatsby") || /gatsby/i.test(scripts)) {
      hints.add("Gatsby");
    }
    if (/vite/i.test(scripts) || document.querySelector("script[type=\"module\"][src*=\"/@vite/client\"]")) {
      hints.add("Vite");
    }
    if (body.className && /\bwp-|wordpress/i.test(String(body.className))) {
      hints.add("WordPress");
    }
    if (/Shopify|cdn\.shopify/i.test(scripts)) {
      hints.add("Shopify");
    }
    if (/webflow/i.test(scripts) || html.classList.contains("w-mod-js")) {
      hints.add("Webflow");
    }

    return Array.from(hints).slice(0, 8);
  }

  function detectComponentLibraryHints(element: Element): string[] {
    const hints = new Set<string>();
    const scope = [element, ...Array.from(element.querySelectorAll("*")).slice(0, 80)];
    const classText = scope.map((candidate) => (candidate as HTMLElement).className || "").join(" ");

    if (/\bMui[A-Z-]|\bMui-/.test(classText)) {
      hints.add("Material UI");
    }
    if (/\bchakra-|\bchakra\b/.test(classText) || element.closest("[data-theme]")) {
      hints.add("Chakra UI");
    }
    if (/\bant-/.test(classText)) {
      hints.add("Ant Design");
    }
    if (/\bbtn\b|\bcontainer\b|\brow\b|\bcol-/.test(classText)) {
      hints.add("Bootstrap-like classes");
    }
    if (scope.some((candidate) => candidate.hasAttribute("data-radix-collection-item") || Array.from(candidate.attributes).some((attribute) => attribute.name.startsWith("data-radix")))) {
      hints.add("Radix UI");
    }
    if (scope.some((candidate) => candidate.hasAttribute("data-slot"))) {
      hints.add("slot-based component primitives");
    }
    if (/\btw-|\bsm:|\bmd:|\blg:|\bflex\b|\bgrid\b|\brounded-|\btext-|\bbg-/.test(classText)) {
      hints.add("utility CSS classes");
    }

    return Array.from(hints).slice(0, 8);
  }

  function collectCssFileClues(): string[] {
    return Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~=\"stylesheet\"][href]"))
      .map((link) => clipAssetUrl(link.href))
      .filter((href): href is string => Boolean(href))
      .slice(0, 8);
  }

  function collectFontFamilyClues(element: Element): string[] {
    const candidates = [element, element.parentElement, document.body, document.documentElement].filter(Boolean) as Element[];
    const fonts = candidates
      .map((candidate) => shortFontFamilyInPage(window.getComputedStyle(candidate).fontFamily))
      .filter(Boolean);
    return Array.from(new Set(fonts)).slice(0, 6);
  }

  function collectCssVariableClues(element: Element): CapturedUiCssVariableClue[] {
    const clues: CapturedUiCssVariableClue[] = [];
    appendCssVariablesFromStyle(clues, window.getComputedStyle(element), "element");
    appendCssVariablesFromStyle(clues, window.getComputedStyle(document.documentElement), "root");
    return clues.slice(0, 20);
  }

  function appendCssVariablesFromStyle(clues: CapturedUiCssVariableClue[], style: CSSStyleDeclaration, source: "element" | "root"): void {
    for (let index = 0; index < style.length && clues.length < 20; index += 1) {
      const name = style.item(index);
      if (!name.startsWith("--")) {
        continue;
      }
      const value = clipAttributeValue(style.getPropertyValue(name), 120);
      if (!value || clues.some((clue) => clue.name === name)) {
        continue;
      }
      clues.push({ name, value, source });
    }
  }

  function collectScriptHints(): string[] {
    return Array.from(document.scripts)
      .map((script) => script.src)
      .filter(Boolean)
      .map((src) => clipAssetUrl(src))
      .filter((src): src is string => Boolean(src))
      .slice(0, 8);
  }

  function shortFontFamilyInPage(value: string): string {
    return value.split(",")[0]?.replace(/^["']|["']$/g, "").trim().slice(0, 80) || "";
  }

  function associatedLabelForElement(element: Element): string | undefined {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      return undefined;
    }

    const label = element.id ? document.querySelector(`label[for="${cssStringEscape(element.id)}"]`) : element.closest("label");
    const labelText = normalizeText(label?.textContent || "");
    return labelText ? labelText.slice(0, 160) : undefined;
  }

  function isInteractiveElement(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || inferredRole(element);
    return tagName === "a" && element.hasAttribute("href") ||
      tagName === "button" ||
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      tagName === "summary" ||
      role === "button" ||
      role === "link" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "textbox" ||
      element.hasAttribute("onclick") ||
      window.getComputedStyle(element).cursor === "pointer";
  }

  function isFocusableElement(element: Element): boolean {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
      return false;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && element.hasAttribute("href")) {
      return true;
    }
    if (element.hasAttribute("tabindex")) {
      return Number(element.getAttribute("tabindex")) >= 0;
    }
    return false;
  }

  function effectiveBackgroundColor(element: Element): { raw: string; display: string } {
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const color = window.getComputedStyle(current).backgroundColor;
      if (!isTransparentColorInPage(color)) {
        return {
          raw: color,
          display: compactCssColorInPage(color) || color
        };
      }
      current = current.parentElement;
    }
    return {
      raw: "rgb(255, 255, 255)",
      display: "#ffffff"
    };
  }

  function contrastRatioForColors(foreground: string, background: string): number | undefined {
    const fg = parseRgbColor(foreground);
    const bg = parseRgbColor(background);
    if (!fg || !bg) {
      return undefined;
    }
    const fgLum = relativeLuminance(fg);
    const bgLum = relativeLuminance(bg);
    const lighter = Math.max(fgLum, bgLum);
    const darker = Math.min(fgLum, bgLum);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function relativeLuminance(color: { red: number; green: number; blue: number }): number {
    const channels = [color.red, color.green, color.blue].map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }

  function parseRgbColor(value: string): { red: number; green: number; blue: number } | undefined {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/i.exec(value.trim());
    if (!match) {
      return undefined;
    }
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (alpha === 0) {
      return undefined;
    }
    return {
      red: Number(match[1]),
      green: Number(match[2]),
      blue: Number(match[3])
    };
  }

  function compactCssColorInPage(value: string): string | undefined {
    const parsed = parseRgbColor(value);
    if (!parsed) {
      return value.trim() || undefined;
    }
    return `#${toHexInPage(parsed.red)}${toHexInPage(parsed.green)}${toHexInPage(parsed.blue)}`;
  }

  function isTransparentColorInPage(value: string): boolean {
    return value === "transparent" || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(value.trim());
  }

  function toHexInPage(value: number): string {
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  }

  function summarizeImageAsset(element: HTMLImageElement): CapturedUiAssetImage {
    const selectorResult = buildCssSelector(element);
    return {
      src: clipAssetUrl(element.getAttribute("src") || element.currentSrc || element.src),
      alt: clipAttributeValue(element.alt, 160) || undefined,
      selector: selectorResult.selector,
      selectorConfidence: selectorResult.confidence,
      bounds: elementBounds(element.getBoundingClientRect()),
      loading: element.loading || undefined
    };
  }

  function summarizeSvgAsset(element: SVGSVGElement): CapturedUiAssetSvg {
    const selectorResult = buildCssSelector(element);
    const rect = element.getBoundingClientRect();
    const title = normalizeText(element.querySelector("title")?.textContent || "");
    const ariaLabel = normalizeText(element.getAttribute("aria-label") || "");
    return {
      selector: selectorResult.selector,
      selectorConfidence: selectorResult.confidence,
      bounds: elementBounds(rect),
      title: title ? title.slice(0, 120) : undefined,
      ariaLabel: ariaLabel ? ariaLabel.slice(0, 120) : undefined,
      role: element.getAttribute("role") || undefined,
      iconLike: rect.width <= 96 && rect.height <= 96
    };
  }

  function summarizeVideoAsset(element: HTMLVideoElement): CapturedUiAssetVideo {
    const selectorResult = buildCssSelector(element);
    return {
      src: clipAssetUrl(element.getAttribute("src") || element.currentSrc || element.src),
      poster: clipAssetUrl(element.getAttribute("poster") || element.poster),
      selector: selectorResult.selector,
      selectorConfidence: selectorResult.confidence,
      bounds: elementBounds(element.getBoundingClientRect())
    };
  }

  function collectBackgroundImageAssets(element: Element): CapturedUiAssetBackgroundImage[] {
    const candidates = uniqueElements([element, ...Array.from(element.querySelectorAll("*"))]).slice(0, 80);
    const assets: CapturedUiAssetBackgroundImage[] = [];
    for (const candidate of candidates) {
      const urls = extractBackgroundImageUrls(window.getComputedStyle(candidate).backgroundImage);
      if (!urls.length) {
        continue;
      }
      const selectorResult = buildCssSelector(candidate);
      for (const url of urls) {
        const clippedUrl = clipAssetUrl(url);
        if (!clippedUrl) {
          continue;
        }
        assets.push({
          url: clippedUrl,
          selector: selectorResult.selector,
          selectorConfidence: selectorResult.confidence
        });
        if (assets.length >= 5) {
          return assets;
        }
      }
    }
    return assets;
  }

  function extractBackgroundImageUrls(value: string): string[] {
    if (!value || value === "none") {
      return [];
    }
    const urls: string[] = [];
    const matcher = /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g;
    let match = matcher.exec(value);
    while (match) {
      const url = normalizeText(match[1] || match[2] || match[3] || "");
      if (url) {
        urls.push(url);
      }
      match = matcher.exec(value);
    }
    return urls.slice(0, 3);
  }

  function uniqueElements<T extends Element>(elements: T[]): T[] {
    return Array.from(new Set(elements));
  }

  function clipAssetUrl(value: string): string | undefined {
    const normalized = normalizeText(value);
    if (!normalized) {
      return undefined;
    }
    try {
      return new URL(normalized, location.href).href.slice(0, 300);
    } catch {
      return normalized.slice(0, 300);
    }
  }

  function summarizeParentLayout(element: Element): CapturedUiLayoutContext["parent"] {
    const summary = summarizeLayoutElement(element);
    const style = window.getComputedStyle(element);
    return {
      ...summary,
      flexDirection: style.flexDirection && style.display.includes("flex") ? style.flexDirection : undefined,
      alignItems: style.alignItems && style.display.includes("flex") ? style.alignItems : undefined,
      justifyContent: style.justifyContent && style.display.includes("flex") ? style.justifyContent : undefined,
      gap: style.gap && style.gap !== "normal" ? style.gap : undefined,
      gridTemplateColumns: style.display.includes("grid") ? clipAttributeValue(style.gridTemplateColumns, 180) || undefined : undefined
    };
  }

  function summarizeLayoutElement(element: Element): CapturedUiLayoutElementSummary {
    const selectorResult = buildCssSelector(element);
    const style = window.getComputedStyle(element);
    return {
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || inferredRole(element),
      label: layoutElementLabel(element),
      selector: selectorResult.selector,
      selectorConfidence: selectorResult.confidence,
      bounds: elementBounds(element.getBoundingClientRect()),
      display: style.display
    };
  }

  function findNearestSemanticContainer(element: Element): CapturedUiLayoutElementSummary | undefined {
    let current = element.parentElement;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 8) {
      if (isSemanticContainer(current)) {
        return summarizeLayoutElement(current);
      }
      current = current.parentElement;
      depth += 1;
    }
    return undefined;
  }

  function isSemanticContainer(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    return tagName === "header" ||
      tagName === "nav" ||
      tagName === "main" ||
      tagName === "section" ||
      tagName === "article" ||
      tagName === "aside" ||
      tagName === "form" ||
      tagName === "footer" ||
      role === "navigation" ||
      role === "banner" ||
      role === "main" ||
      role === "region" ||
      role === "form" ||
      role === "group";
  }

  function isVisibleLayoutElement(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  }

  function layoutElementLabel(element: Element): string | undefined {
    const ariaLabel = normalizeText(element.getAttribute("aria-label") || "");
    if (ariaLabel) {
      return ariaLabel.slice(0, 100);
    }
    const alt = element instanceof HTMLImageElement ? normalizeText(element.alt || "") : "";
    if (alt) {
      return alt.slice(0, 100);
    }
    const text = normalizeText((element as HTMLElement).innerText || element.textContent || "");
    return text ? text.slice(0, 120) : undefined;
  }

  function choosePrimaryElement(hitElement: Element): Element {
    let bestElement = hitElement;
    let bestScore = scoreCaptureCandidate(hitElement, hitElement, 0);
    let current = hitElement.parentElement;
    let depth = 1;

    while (current && current !== document.body && current !== document.documentElement && depth <= 8) {
      const score = scoreCaptureCandidate(current, hitElement, depth);
      if (score > bestScore || (score === bestScore && isStrongSemanticTarget(current) && !isStrongSemanticTarget(bestElement))) {
        bestElement = current;
        bestScore = score;
      }

      if (isStrongSemanticTarget(current) && score >= 80) {
        break;
      }

      current = current.parentElement;
      depth += 1;
    }

    return bestElement;
  }

  function scoreCaptureCandidate(candidate: Element, hitElement: Element, depth: number): number {
    const tagName = candidate.tagName.toLowerCase();
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    const selectorConfidence = buildCssSelector(candidate).confidence;
    const role = candidate.getAttribute("role") || inferredRole(candidate);
    const text = normalizeText((candidate as HTMLElement).innerText || candidate.textContent || "");
    const accessibleName = computeAccessibleName(candidate, text);
    let score = Math.max(0, 24 - depth * 4);

    if (tagName === "a" && candidate.hasAttribute("href")) {
      score += 80;
    }
    if (tagName === "button") {
      score += 80;
    }
    if (tagName === "input" || tagName === "textarea" || tagName === "select") {
      score += 75;
    }
    if (role === "button" || role === "link") {
      score += 65;
    }
    if (candidate.getAttribute("aria-label")) {
      score += 35;
    }
    if (candidate.getAttribute("data-testid") || candidate.getAttribute("data-test") || candidate.getAttribute("data-cy")) {
      score += 35;
    }
    if (candidate.id) {
      score += 20;
    }
    if (candidate.getAttribute("name")) {
      score += 20;
    }
    if (candidate.hasAttribute("onclick")) {
      score += 20;
    }
    if (style.cursor === "pointer") {
      score += 25;
    }
    if (accessibleName) {
      score += 20;
    } else if (text) {
      score += 12;
    }
    if (selectorConfidence === "high") {
      score += 20;
    } else if (selectorConfidence === "medium") {
      score += 10;
    }
    if (rect.width >= 8 && rect.height >= 8 && rect.width * rect.height >= 64) {
      score += 10;
    }
    if (isSvgInternal(candidate)) {
      score -= 80;
    } else if (tagName === "svg") {
      score -= 50;
    }
    if (isIconOnlySpan(candidate)) {
      score -= 35;
    }
    if ((rect.width < 8 || rect.height < 8) && candidate !== hitElement) {
      score -= 25;
    }
    if (rect.width > window.innerWidth * 0.85 && rect.height > window.innerHeight * 0.65) {
      score -= 80;
    }
    if (tagName === "main" || tagName === "section" || tagName === "article" || tagName === "header" || tagName === "footer" || tagName === "nav") {
      score -= 30;
    }
    if (tagName === "div" && !accessibleName && !candidate.id && !candidate.getAttribute("role") && !candidate.getAttribute("data-testid") && !candidate.getAttribute("data-test") && !candidate.getAttribute("data-cy") && style.cursor !== "pointer") {
      score -= 12;
    }

    return score;
  }

  function isStrongSemanticTarget(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || inferredRole(element);
    return (tagName === "a" && element.hasAttribute("href")) ||
      tagName === "button" ||
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      role === "button" ||
      role === "link" ||
      Boolean(element.getAttribute("aria-label")) ||
      Boolean(element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy")) ||
      window.getComputedStyle(element).cursor === "pointer";
  }

  function isSvgInternal(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    return tagName === "path" ||
      tagName === "circle" ||
      tagName === "rect" ||
      tagName === "use" ||
      tagName === "line" ||
      tagName === "polyline" ||
      tagName === "polygon" ||
      tagName === "g";
  }

  function isIconOnlySpan(element: Element): boolean {
    const tagName = element.tagName.toLowerCase();
    if (tagName !== "span" && tagName !== "i") {
      return false;
    }

    const text = normalizeText((element as HTMLElement).innerText || element.textContent || "");
    return !text && !element.getAttribute("aria-label") && !element.getAttribute("role") && element.children.length > 0;
  }

  function elementBounds(rect: DOMRect): CapturedUiBounds {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function computeAccessibleName(element: Element, textFallback?: string): string | undefined {
    const ariaLabel = normalizeText(element.getAttribute("aria-label") || "");
    if (ariaLabel) {
      return ariaLabel.slice(0, 180);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelledText = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      const normalized = normalizeText(labelledText);
      if (normalized) {
        return normalized.slice(0, 180);
      }
    }

    if (element instanceof HTMLImageElement) {
      const alt = normalizeText(element.alt || "");
      if (alt) {
        return alt.slice(0, 180);
      }
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const id = element.id;
      const label = id ? document.querySelector(`label[for="${cssStringEscape(id)}"]`) : element.closest("label");
      const labelText = normalizeText(label?.textContent || "");
      if (labelText) {
        return labelText.slice(0, 180);
      }
    }

    const normalizedFallback = normalizeText(textFallback || "");
    return normalizedFallback ? normalizedFallback.slice(0, 180) : undefined;
  }

  function getElementType(element: Element): string | undefined {
    if (element instanceof HTMLButtonElement) {
      return element.type || "submit";
    }
    if (element instanceof HTMLInputElement) {
      return element.type || "text";
    }
    return element.getAttribute("type") || undefined;
  }

  function clipAttributeValue(value: string, maxLength: number): string {
    return normalizeText(value).slice(0, maxLength);
  }

  function labelForElement(element: Element): string {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || inferredRole(element);
    const name = element.getAttribute("aria-label") ||
      normalizeText((element as HTMLElement).innerText || element.textContent || "").slice(0, 48);
    return [`<${tagName}>`, role, name].filter(Boolean).join(" ");
  }

  function buildCssSelector(element: Element): { selector: string; confidence: "high" | "medium" | "low" } {
    const tagName = element.tagName.toLowerCase();
    if (element.id) {
      const selector = `${tagName}#${cssEscape(element.id)}`;
      if (isUnique(selector)) {
        return { selector, confidence: "high" };
      }
    }

    for (const attr of ["data-testid", "data-test", "data-cy", "name", "aria-label", "href", "alt"]) {
      const value = element.getAttribute(attr);
      if (!value?.trim()) {
        continue;
      }

      const selector = `${tagName}[${attr}="${cssStringEscape(value.trim())}"]`;
      if (isUnique(selector)) {
        return { selector, confidence: "high" };
      }
    }

    const classes = Array.from(element.classList)
      .filter((className) => className && !/^\d/.test(className))
      .slice(0, 3);
    if (classes.length) {
      const selector = `${tagName}${classes.map((className) => `.${cssEscape(className)}`).join("")}`;
      if (isUnique(selector)) {
        return { selector, confidence: "medium" };
      }
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body && current !== document.documentElement) {
      const currentTag = current.tagName.toLowerCase();
      const stable = stableSelectorPart(current);
      parts.unshift(stable ?? `${currentTag}:nth-of-type(${nthOfType(current)})`);
      const selector = parts.join(" > ");
      if (isUnique(selector)) {
        return { selector, confidence: stable ? "medium" : "low" };
      }
      current = current.parentElement;
    }

    parts.unshift("body");
    return { selector: parts.join(" > "), confidence: "low" };
  }

  function stableSelectorPart(element: Element): string | undefined {
    const tagName = element.tagName.toLowerCase();
    for (const attr of ["data-testid", "data-test", "data-cy", "name", "href", "aria-label", "alt"]) {
      const value = element.getAttribute(attr);
      if (value?.trim()) {
        return `${tagName}[${attr}="${cssStringEscape(value.trim())}"]`;
      }
    }
    if (element.id) {
      return `${tagName}#${cssEscape(element.id)}`;
    }
    return undefined;
  }

  function isUnique(selector: string): boolean {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function nthOfType(element: Element): number {
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function collectDataAttributes(element: Element): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes).slice(0, 80)) {
      if (!attribute.name.startsWith("data-") || !attribute.value.trim()) {
        continue;
      }
      entries[attribute.name] = attribute.value.trim().slice(0, 160);
      if (Object.keys(entries).length >= 16) {
        break;
      }
    }
    return entries;
  }

  function boxValue(style: CSSStyleDeclaration, prefix: "padding" | "margin"): string {
    const top = style.getPropertyValue(`${prefix}-top`);
    const right = style.getPropertyValue(`${prefix}-right`);
    const bottom = style.getPropertyValue(`${prefix}-bottom`);
    const left = style.getPropertyValue(`${prefix}-left`);
    return [top, right, bottom, left].join(" ");
  }

  function borderValue(style: CSSStyleDeclaration): string {
    return [
      style.borderTopWidth,
      style.borderTopStyle,
      style.borderTopColor
    ].filter(Boolean).join(" ");
  }

  function inferredRole(element: Element): string | undefined {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tagName === "button" || tagName === "summary") {
      return "button";
    }
    if (tagName === "select") {
      return "combobox";
    }
    if (tagName === "textarea") {
      return "textbox";
    }
    if (tagName === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return type;
      }
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      return "textbox";
    }
    return undefined;
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssStringEscape(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function normalizeText(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
}
