/**
 * Actionable-element capture overlay (foundation v1).
 *
 * Paints a numbered map of the page's VISIBLE, reachable actionable elements and
 * returns a structured array describing each one. This is the deterministic
 * "observe" surface a later weighting/ranking/intent layer will build on — the
 * rendering rigor here (scroll-lock, zero overlap, no layout mutation) is the
 * point of this build. Only weighting/ranking is deferred.
 *
 * Architecture:
 *   - The injected function (runActionableOverlay) is fully self-contained — it
 *     closes over NOTHING from module scope, because chrome.scripting.executeScript
 *     serializes it into the page's ISOLATED world. All shared constants are
 *     inlined or passed as args. It uses the DOM + geometry only; no chrome.debugger.
 *   - The service worker calls showActionableOverlay() to inject it and get the
 *     structured capture back, and hideActionableOverlay() to tear it down.
 *
 * SCROLL-LOCK APPROACH (criterion 1): markers live in a DOCUMENT-coordinate
 * container (position:absolute on <html>, offset by scrollX/scrollY at paint
 * time), so ordinary page scroll moves them natively with the page — no per-frame
 * loop for the common case. A rAF-throttled re-measure additionally fires on
 * scroll (capture phase, so sub-scrollers are caught), resize, and visualViewport
 * resize/scroll (zoom / pinch), recomputing every marker from a live
 * getBoundingClientRect(). Because every update reads the live rect, fixed/sticky
 * elements and sub-scroller children stay locked with zero drift.
 */

import { ingestPage } from "../webcorpus/ingestPage";
import { writePage } from "../webcorpus/webCorpusStore";

export type AccessibleNameSource =
  | "aria-label"
  | "aria-labelledby"
  | "label-element"
  | "label-wrapping"
  | "placeholder"
  | "value"
  | "alt"
  | "title"
  | "text"
  | "none";

export type ActionableBounds = {
  /** Viewport-relative (CSS px) at capture time. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Document-absolute (page) coordinates: viewport + scroll offset. */
  pageX: number;
  pageY: number;
};

export type ActionableRawAttributes = {
  id?: string;
  name?: string;
  type?: string;
  hasHref: boolean;
  hasAriaLabel: boolean;
  hasAriaLabelledby: boolean;
  /** True when ANY aria-* attribute is present. */
  hasAnyAria: boolean;
};

/**
 * Read-only link/navigation enrichment captured in the SAME pass (no navigation,
 * no network). Lets the loop reason about WHERE an element would take you before
 * deciding to act on it. Present only for elements that actually carry a link
 * destination (anchors, and area/form-action where resolvable).
 */
export type ActionableLinkInfo = {
  /** Absolute, resolved destination URL. */
  href: string;
  /** Pathname (+ search) of the destination, for compact display. */
  path: string;
  /** Destination origin. */
  origin: string;
  /** Relationship of the destination origin to the current page. */
  rel: "same-origin" | "same-site" | "external";
  /** Anchor target (_blank/_self/...) when set. */
  target?: string;
  /** True when the anchor is a download link. */
  isDownload: boolean;
  /** Coarse destination kind, cheaply inferred from the URL. */
  kind: "navigation" | "hash" | "mailto" | "tel" | "file-download" | "external";
};

export type ActionableElement = {
  /** 1-based index in document order, matching the painted badge. */
  index: number;
  tagName: string;
  type?: string;
  /** Explicit role attribute when present, else an implicit role we inferred. */
  role?: string;
  roleSource: "explicit" | "implicit" | "none";
  accessibleName?: string;
  accessibleNameSource: AccessibleNameSource;
  bounds: ActionableBounds;
  inViewport: boolean;
  isVisible: boolean;
  isEnabled: boolean;
  /** Why this element qualified as actionable (the matched signal). */
  matchedBy: string;
  attributes: ActionableRawAttributes;
  /** Read-only destination enrichment when the element links somewhere. */
  link?: ActionableLinkInfo;
};

export type OverlayCaptureResult = {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
    documentWidth: number;
    documentHeight: number;
  };
  elements: ActionableElement[];
  /** Count of raw candidates before the dedup rule was applied. */
  candidateCount: number;
  /** Count dropped by the nested-container dedup rule. */
  droppedByDedup: number;
  warnings: string[];
};

const OVERLAY_ROOT_ID = "__ohmygod_actionable_overlay__";
const PAGE_CHANGE_REPAINT_DELAY_MS = 350;

const activeActionableOverlayTabs = new Set<number>();
const pendingPageChangeRepaints = new Map<number, ReturnType<typeof globalThis.setTimeout>>();

/** True for normal web pages the overlay can run on. */
function isOverlaySupportedUrl(url: string | undefined): boolean {
  return Boolean(url && /^https?:/i.test(url));
}

function cancelScheduledActionableOverlayRepaint(tabId: number): void {
  const timer = pendingPageChangeRepaints.get(tabId);
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
    pendingPageChangeRepaints.delete(tabId);
  }
}

export function isActionableOverlayTracked(tabId: number): boolean {
  return activeActionableOverlayTabs.has(tabId);
}

export function forgetActionableOverlayTab(tabId: number): void {
  cancelScheduledActionableOverlayRepaint(tabId);
  activeActionableOverlayTabs.delete(tabId);
}

export function transferActionableOverlayTab(previousTabId: number, nextTabId: number): boolean {
  const wasTracked = activeActionableOverlayTabs.delete(previousTabId);
  cancelScheduledActionableOverlayRepaint(previousTabId);
  if (wasTracked) {
    activeActionableOverlayTabs.add(nextTabId);
  }
  return wasTracked;
}

export async function clearActionableOverlayForPageChange(tabId: number): Promise<boolean> {
  if (!activeActionableOverlayTabs.has(tabId)) {
    return false;
  }
  cancelScheduledActionableOverlayRepaint(tabId);
  await teardownActionableOverlayInTab(tabId);
  return true;
}

export function scheduleActionableOverlayRepaint(tabId: number, delayMs = PAGE_CHANGE_REPAINT_DELAY_MS): boolean {
  if (!activeActionableOverlayTabs.has(tabId)) {
    return false;
  }
  cancelScheduledActionableOverlayRepaint(tabId);
  const timer = globalThis.setTimeout(() => {
    pendingPageChangeRepaints.delete(tabId);
    if (!activeActionableOverlayTabs.has(tabId)) {
      return;
    }
    void showActionableOverlay(tabId).catch(() => {
      // Keep the tab tracked. A later complete/url event can retry the repaint.
    });
  }, delayMs);
  pendingPageChangeRepaints.set(tabId, timer);
  return true;
}

/**
 * Inject the overlay into the active tab, paint it, and return the structured
 * capture. The overlay stays on screen until hideActionableOverlay() is called.
 */
export async function showActionableOverlay(tabId?: number): Promise<OverlayCaptureResult> {
  const tab = tabId !== undefined
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) {
    throw new Error("No active tab is available for the actionable overlay.");
  }
  if (!isOverlaySupportedUrl(tab.url)) {
    throw new Error("The actionable overlay works on normal http(s) pages. Chrome internal pages such as chrome:// cannot be captured.");
  }
  cancelScheduledActionableOverlayRepaint(tab.id);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    func: runActionableOverlay,
    args: [OVERLAY_ROOT_ID]
  });

  const value = result?.result as OverlayCaptureResult | undefined;
  if (!value) {
    throw new Error("Actionable overlay returned no result.");
  }
  activeActionableOverlayTabs.add(tab.id);
  // Fold EVERY capture into the accumulating web corpus — including the very
  // first overlay a run triggers on the page you're already on (which never
  // passes through the navigation listener). Best-effort and detached: the
  // capture's return contract is unchanged and a persist failure is swallowed.
  void persistCaptureToWebCorpus(value);
  return value;
}

async function persistCaptureToWebCorpus(capture: OverlayCaptureResult): Promise<void> {
  try {
    const ingested = ingestPage(capture, new Date().toISOString());
    if (ingested) {
      await writePage({ ...ingested, now: new Date().toISOString() });
    }
  } catch {
    // mapping is opportunistic, never load-bearing for capture.
  }
}

/** Remove the overlay and all its listeners with zero residue. */
export async function hideActionableOverlay(tabId?: number): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = tabId !== undefined
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    if (tabId !== undefined) {
      forgetActionableOverlayTab(tabId);
    }
    return;
  }
  if (!tab?.id) {
    return;
  }
  forgetActionableOverlayTab(tab.id);
  await teardownActionableOverlayInTab(tab.id);
}

export async function hideAllActionableOverlays(): Promise<void> {
  const tabIds = Array.from(activeActionableOverlayTabs);
  await Promise.all(tabIds.map((id) => hideActionableOverlay(id).catch(() => undefined)));
}

async function teardownActionableOverlayInTab(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!tab.id || !isOverlaySupportedUrl(tab.url)) {
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    func: teardownActionableOverlay,
    args: [OVERLAY_ROOT_ID]
  }).catch(() => undefined);
}

/** ISOLATED-world teardown helper (self-contained). */
function teardownActionableOverlay(rootId: string): void {
  const w = window as unknown as { __ohmygodOverlayTeardown?: () => void };
  if (typeof w.__ohmygodOverlayTeardown === "function") {
    w.__ohmygodOverlayTeardown();
    return;
  }
  // Fallback: remove the root and any index stamps left behind.
  document.getElementById(rootId)?.remove();
  document.querySelectorAll("[data-ohmygod-idx]").forEach((n) => n.removeAttribute("data-ohmygod-idx"));
}

/**
 * THE INJECTED OVERLAY (runs in the page's ISOLATED world).
 *
 * Self-contained: closes over nothing from module scope. Enumerates actionable
 * elements, applies the nested dedup rule, paints document-coordinate markers +
 * collision-resolved badges, installs a rAF-throttled re-measure for scroll-lock,
 * and returns the structured capture.
 */
function runActionableOverlay(rootId: string): OverlayCaptureResult {
  // Tear down any prior instance first (idempotent re-invoke).
  const priorTeardown = (window as unknown as { __ohmygodOverlayTeardown?: () => void }).__ohmygodOverlayTeardown;
  if (typeof priorTeardown === "function") {
    priorTeardown();
  }
  document.getElementById(rootId)?.remove();

  const warnings: string[] = [];
  const scrollEl = document.scrollingElement ?? document.documentElement;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // --- 1. Enumerate candidate actionable elements -----------------------------
  const SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[role='link']",
    "[onclick]",
    "[tabindex]"
  ].join(",");

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));

  type Scored = {
    element: HTMLElement;
    rect: DOMRect;
    matchedBy: string;
    visible: boolean;
    inViewport: boolean;
  };

  const matchReason = (el: HTMLElement): string | undefined => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "a[href]";
    if (tag === "button") return "button";
    if (tag === "input") return "input";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "button") return "role=button";
    if (role === "link") return "role=link";
    if (el.hasAttribute("onclick")) return "onclick";
    const tabindexAttr = el.getAttribute("tabindex");
    if (tabindexAttr !== null) {
      const ti = parseInt(tabindexAttr, 10);
      if (Number.isFinite(ti) && ti >= 0) return "tabindex>=0";
    }
    // cursor:pointer is checked separately (expensive) on the survivors below.
    return undefined;
  };

  const isVisible = (el: HTMLElement, rect: DOMRect, style: CSSStyleDeclaration): boolean => {
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    if (parseFloat(style.opacity || "1") === 0) {
      return false;
    }
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    return true;
  };

  // Clip-aware visibility: an element whose box is non-zero can still be hidden
  // because a scrollable ANCESTOR (overflow:auto/scroll/hidden) clips it out of
  // its own viewport — the classic sub-scroller case where rows scrolled out of
  // the container are not on screen yet still report a non-zero rect. We walk the
  // ancestor chain and require the element's rect to intersect every clipping
  // ancestor's client rect. Without this, clipped rows get ghost markers floating
  // over empty page space (criterion 1/2 violation).
  const isClippedByAncestor = (el: HTMLElement, rect: DOMRect): boolean => {
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const ps = window.getComputedStyle(parent);
      const clips =
        ps.overflow !== "visible" ||
        ps.overflowX !== "visible" ||
        ps.overflowY !== "visible";
      if (clips && (ps.overflowX !== "visible" || ps.overflowY !== "visible")) {
        const pr = parent.getBoundingClientRect();
        // No vertical/horizontal overlap with the clipping container => clipped out.
        const noOverlap =
          rect.bottom <= pr.top ||
          rect.top >= pr.bottom ||
          rect.right <= pr.left ||
          rect.left >= pr.right;
        if (noOverlap) {
          return true;
        }
      }
      parent = parent.parentElement;
    }
    return false;
  };

  // Unreachable-offscreen filter: keep elements within a generous band around the
  // document (so off-screen-but-scrollable-to elements still count), but drop
  // those positioned far outside the document (the classic visually-hidden
  // "left:-9999px" pattern).
  const docWidth = Math.max(scrollEl.scrollWidth, document.documentElement.clientWidth);
  const docHeight = Math.max(scrollEl.scrollHeight, document.documentElement.clientHeight);
  const isReachable = (rect: DOMRect): boolean => {
    const pageLeft = rect.left + scrollX;
    const pageTop = rect.top + scrollY;
    const OFF = 4000; // tolerance band beyond the document box
    if (pageLeft + rect.width < -OFF || pageLeft > docWidth + OFF) return false;
    if (pageTop + rect.height < -OFF || pageTop > docHeight + OFF) return false;
    return true;
  };

  const scored: Scored[] = [];
  for (const el of candidates) {
    if ((el as Element).closest(`#${rootId}`)) {
      continue; // NO SELF-CAPTURE (criterion 4)
    }
    let matchedBy = matchReason(el);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (!matchedBy) {
      // Only consider cursor:pointer for elements not already matched, and only
      // when they actually have a pointer cursor (a deliberate-affordance signal).
      if (style.cursor === "pointer") {
        matchedBy = "cursor:pointer";
      } else {
        continue;
      }
    }
    const visible = isVisible(el, rect, style);
    if (!visible) {
      continue;
    }
    if (!isReachable(rect)) {
      continue;
    }
    if (isClippedByAncestor(el, rect)) {
      continue; // hidden by a scrollable ancestor (e.g. scrolled out of a sub-scroller)
    }
    const inViewport =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    scored.push({ element: el, rect, matchedBy, visible, inViewport });
  }

  const candidateCount = scored.length;

  // --- 2. Dedup rule: keep the INNERMOST actionable target --------------------
  // RULE: a native leaf control (button / input / select / textarea) is never a
  // container — it is always kept. A NON-leaf actionable (a, [role], [onclick],
  // [tabindex], cursor:pointer wrapper) that contains one or more kept actionable
  // descendants is "merely a container of actionables" (e.g. a clickable card
  // wrapping a button, or a row wrapping a link) and is DROPPED in favor of the
  // innermost target(s). This guarantees each nested actionable region is marked
  // exactly once with no box/badge stacking on the same controls.
  const LEAF_TAGS = new Set(["button", "input", "select", "textarea"]);
  const isLeafControl = (el: HTMLElement): boolean => LEAF_TAGS.has(el.tagName.toLowerCase());

  const containsActionableDescendant = (el: HTMLElement): boolean =>
    scored.some((s) => s.element !== el && el.contains(s.element));

  const droppedSet = new Set<HTMLElement>();
  for (const s of scored) {
    if (isLeafControl(s.element)) {
      continue; // native controls are always targets, never containers
    }
    if (containsActionableDescendant(s.element)) {
      // Non-leaf wrapper around other actionables → drop the wrapper, keep the
      // innermost actionable(s) it contains.
      droppedSet.add(s.element);
    }
  }

  const kept = scored.filter((s) => !droppedSet.has(s.element));
  const droppedByDedup = scored.length - kept.length;

  // Document order for stable indices.
  kept.sort((a, b) => {
    const pos = a.element.compareDocumentPosition(b.element);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // --- 3. Accessible name (best-effort, records the SOURCE) -------------------
  const norm = (v: string | null | undefined): string =>
    (v ?? "").replace(/\s+/g, " ").trim();

  const accessibleName = (el: HTMLElement): { name: string; source: AccessibleNameSource } => {
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return { name: aria.slice(0, 200), source: "aria-label" };

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const txt = norm(
        labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      );
      if (txt) return { name: txt.slice(0, 200), source: "aria-labelledby" };
    }

    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent ?? "").join(" ") : "";
      const labelTxt = norm(labels);
      if (labelTxt) return { name: labelTxt.slice(0, 200), source: "label-element" };
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      const wrapTxt = norm(wrapping.textContent);
      if (wrapTxt) return { name: wrapTxt.slice(0, 200), source: "label-wrapping" };
    }

    const placeholder = norm(el.getAttribute("placeholder"));
    if (placeholder) return { name: placeholder.slice(0, 200), source: "placeholder" };

    if (el instanceof HTMLInputElement && /^(button|submit|reset)$/i.test(el.type)) {
      const val = norm(el.value);
      if (val) return { name: val.slice(0, 200), source: "value" };
    }

    if (el instanceof HTMLImageElement) {
      const alt = norm(el.alt);
      if (alt) return { name: alt.slice(0, 200), source: "alt" };
    }
    const innerImg = el.querySelector("img[alt]");
    if (innerImg) {
      const alt = norm(innerImg.getAttribute("alt"));
      if (alt) return { name: alt.slice(0, 200), source: "alt" };
    }

    const text = norm(el.innerText || el.textContent);
    if (text) return { name: text.slice(0, 200), source: "text" };

    const title = norm(el.getAttribute("title"));
    if (title) return { name: title.slice(0, 200), source: "title" };

    return { name: "", source: "none" };
  };

  const inferRole = (el: HTMLElement): { role?: string; source: "explicit" | "implicit" | "none" } => {
    const explicit = norm(el.getAttribute("role"));
    if (explicit) return { role: explicit.split(/\s+/)[0], source: "explicit" };
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return { role: "link", source: "implicit" };
    if (tag === "button") return { role: "button", source: "implicit" };
    if (tag === "select") return { role: "combobox", source: "implicit" };
    if (tag === "textarea") return { role: "textbox", source: "implicit" };
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return { role: "checkbox", source: "implicit" };
      if (t === "radio") return { role: "radio", source: "implicit" };
      if (/^(button|submit|reset|image)$/.test(t)) return { role: "button", source: "implicit" };
      return { role: "textbox", source: "implicit" };
    }
    return { role: undefined, source: "none" };
  };

  const isEnabled = (el: HTMLElement): boolean => {
    const disabledProp = (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled;
    if (disabledProp) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    return true;
  };

  // Read-only link enrichment: resolve where this element would take you, WITHOUT
  // following it. Uses the browser's own href resolution (an <a>'s .href is
  // already absolute) so relative links and base hrefs are handled correctly.
  const pageOrigin = location.origin;
  const pageHost = location.hostname;
  // Registrable-ish "site" comparison: last two labels (epsilon for public
  // suffixes like co.uk, but good enough for the same-site hint).
  const siteOf = (host: string): string => host.split(".").slice(-2).join(".");
  const pageSite = siteOf(pageHost);

  const linkInfo = (el: HTMLElement): ActionableLinkInfo | undefined => {
    const rawHref = el.getAttribute("href");
    // Only anchors/areas carry a navigable href; buttons/inputs do not.
    const anchor = el instanceof HTMLAnchorElement ? el : el instanceof HTMLAreaElement ? el : undefined;
    if (!anchor || rawHref === null || rawHref.trim() === "") {
      return undefined;
    }
    const resolved = anchor.href; // already absolute per the DOM
    if (rawHref.startsWith("#")) {
      return { href: resolved, path: rawHref, origin: pageOrigin, rel: "same-origin", isDownload: anchor.hasAttribute("download"), kind: "hash" };
    }
    if (/^mailto:/i.test(rawHref)) {
      return { href: resolved, path: rawHref, origin: "", rel: "external", isDownload: false, kind: "mailto" };
    }
    if (/^tel:/i.test(rawHref)) {
      return { href: resolved, path: rawHref, origin: "", rel: "external", isDownload: false, kind: "tel" };
    }
    let url: URL | undefined;
    try {
      url = new URL(resolved);
    } catch {
      return undefined;
    }
    const rel: ActionableLinkInfo["rel"] =
      url.origin === pageOrigin ? "same-origin" : siteOf(url.hostname) === pageSite ? "same-site" : "external";
    const isDownload = anchor.hasAttribute("download");
    const kind: ActionableLinkInfo["kind"] = isDownload
      ? "file-download"
      : rel === "external"
        ? "external"
        : "navigation";
    return {
      href: resolved,
      path: `${url.pathname}${url.search}`,
      origin: url.origin,
      rel,
      target: (el.getAttribute("target") || undefined) ?? undefined,
      isDownload,
      kind
    };
  };

  const elements: ActionableElement[] = kept.map((s, i) => {
    const el = s.element;
    const rect = s.rect;
    const index = i + 1;
    const name = accessibleName(el);
    const role = inferRole(el);
    const ariaAttrs = el.getAttributeNames().filter((a) => a.startsWith("aria-"));

    // STAMP the deterministic index handle so an action can target this exact
    // node by overlay index (resolveTarget -> [data-ohmygod-idx="N"]).
    el.setAttribute("data-ohmygod-idx", String(index));

    return {
      index,
      tagName: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      role: role.role,
      roleSource: role.source,
      accessibleName: name.name || undefined,
      accessibleNameSource: name.source,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        pageX: Math.round(rect.left + scrollX),
        pageY: Math.round(rect.top + scrollY)
      },
      inViewport: s.inViewport,
      isVisible: s.visible,
      isEnabled: isEnabled(el),
      matchedBy: s.matchedBy,
      attributes: {
        id: el.id || undefined,
        name: el.getAttribute("name") || undefined,
        type: el.getAttribute("type") || undefined,
        hasHref: el.hasAttribute("href"),
        hasAriaLabel: el.hasAttribute("aria-label"),
        hasAriaLabelledby: el.hasAttribute("aria-labelledby"),
        hasAnyAria: ariaAttrs.length > 0
      },
      link: linkInfo(el)
    };
  });

  // --- 4. PAINT — document-coordinate container, no layout mutation -----------
  const root = document.createElement("div");
  root.id = rootId;
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    margin: "0",
    padding: "0",
    border: "0",
    zIndex: "2147483647",
    pointerEvents: "none" // criterion 3: never intercept clicks
  } as CSSStyleDeclaration);

  // Visual tokens (frontend-design: high contrast, depth via shadow, restraint).
  const ACCENT = "#5b8cff";
  const ACCENT_SOLID = "#2b56d4";
  const INK = "#0b0f1a";

  type Marker = { box: HTMLDivElement; badge: HTMLDivElement; el: HTMLElement; index: number };
  const markers: Marker[] = [];

  for (const s of kept) {
    const i = markers.length + 1;
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      boxSizing: "border-box",
      border: `1.5px solid ${ACCENT}`,
      borderRadius: "4px",
      background: "rgba(91,140,255,0.08)",
      boxShadow: `0 0 0 1px rgba(11,15,26,0.35)`,
      pointerEvents: "none"
    } as CSSStyleDeclaration);

    const badge = document.createElement("div");
    badge.textContent = String(i);
    Object.assign(badge.style, {
      position: "absolute",
      minWidth: "16px",
      height: "16px",
      padding: "0 3px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "4px",
      background: ACCENT_SOLID,
      color: "#ffffff",
      font: "700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      letterSpacing: "0.2px",
      boxShadow: `0 1px 2px rgba(11,15,26,0.5), 0 0 0 1.5px rgba(255,255,255,0.85)`,
      textShadow: `0 1px 0 ${INK}`,
      pointerEvents: "none"
    } as CSSStyleDeclaration);

    root.append(box, badge);
    markers.push({ box, badge, el: s.element, index: i });
  }

  // Append to <html> (not <body>) so the absolute container is positioned in the
  // initial containing block's document space and is never affected by body
  // margins/transforms.
  document.documentElement.appendChild(root);

  // Badge collision resolution: candidate corners per marker, pick the first that
  // does not overlap an already-placed badge; if all collide, stack with a small
  // vertical offset. Runs every re-measure so it stays clean through scroll/zoom.
  const BADGE_W_EST = 18;
  const BADGE_H = 16;
  const placedBadges: Array<{ x: number; y: number; w: number; h: number }> = [];
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  const reposition = (): void => {
    placedBadges.length = 0;
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const m of markers) {
      const rect = m.el.getBoundingClientRect();
      // Hide markers whose element is no longer visible (collapsed/removed).
      if (rect.width <= 0 || rect.height <= 0) {
        m.box.style.display = "none";
        m.badge.style.display = "none";
        continue;
      }
      m.box.style.display = "block";
      m.badge.style.display = "flex";

      const pageX = rect.left + sx;
      const pageY = rect.top + sy;
      m.box.style.transform = `translate(${Math.round(pageX)}px, ${Math.round(pageY)}px)`;
      m.box.style.width = `${Math.round(rect.width)}px`;
      m.box.style.height = `${Math.round(rect.height)}px`;

      // Badge: try corners (TL just outside, TL inside, TR, BL), then stack.
      const badgeW = Math.max(BADGE_W_EST, String(m.index).length * 7 + 6);
      const candidatesXY = [
        { x: pageX - 2, y: pageY - BADGE_H - 1 }, // above-left, outside
        { x: pageX + 1, y: pageY + 1 },           // inside top-left
        { x: pageX + rect.width - badgeW - 1, y: pageY + 1 }, // inside top-right
        { x: pageX + 1, y: pageY + rect.height - BADGE_H - 1 } // inside bottom-left
      ];
      let chosen = candidatesXY[0];
      let placedOk = false;
      for (const c of candidatesXY) {
        const boxCand = { x: c.x, y: c.y, w: badgeW, h: BADGE_H };
        if (!placedBadges.some((p) => overlaps(boxCand, p))) {
          chosen = c;
          placedOk = true;
          break;
        }
      }
      if (!placedOk) {
        // All corners collide: stack downward from the inside-top-left until free.
        let y = pageY + 1;
        const x = pageX + 1;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const boxCand = { x, y, w: badgeW, h: BADGE_H };
          if (!placedBadges.some((p) => overlaps(boxCand, p))) {
            chosen = { x, y };
            break;
          }
          y += BADGE_H + 2;
        }
      }
      m.badge.style.transform = `translate(${Math.round(chosen.x)}px, ${Math.round(chosen.y)}px)`;
      placedBadges.push({ x: chosen.x, y: chosen.y, w: badgeW, h: BADGE_H });
    }
  };

  reposition();

  // --- 5. SCROLL-LOCK: rAF-throttled re-measure on scroll/resize/zoom ---------
  let rafId = 0;
  const scheduleReposition = (): void => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      reposition();
    });
  };

  // capture:true so sub-scroller scroll events (which don't bubble) are caught.
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition, true);
  const vv = window.visualViewport;
  vv?.addEventListener("resize", scheduleReposition);
  vv?.addEventListener("scroll", scheduleReposition);

  const teardown = (): void => {
    window.removeEventListener("scroll", scheduleReposition, true);
    window.removeEventListener("resize", scheduleReposition, true);
    vv?.removeEventListener("resize", scheduleReposition);
    vv?.removeEventListener("scroll", scheduleReposition);
    if (rafId) cancelAnimationFrame(rafId);
    document.getElementById(rootId)?.remove();
    // Strip the index stamps so teardown leaves zero residue (criterion 3).
    for (const m of markers) {
      m.el.removeAttribute("data-ohmygod-idx");
    }
    // Belt-and-suspenders: clear any stamp a prior run left behind.
    document.querySelectorAll("[data-ohmygod-idx]").forEach((n) => n.removeAttribute("data-ohmygod-idx"));
    delete (window as unknown as { __ohmygodOverlayTeardown?: () => void }).__ohmygodOverlayTeardown;
  };
  (window as unknown as { __ohmygodOverlayTeardown?: () => void }).__ohmygodOverlayTeardown = teardown;

  if (window.frames.length) {
    warnings.push("Overlay covers the top frame only. Cross-origin frame contents are not enumerated.");
  }

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      documentWidth: Math.round(docWidth),
      documentHeight: Math.round(docHeight)
    },
    elements,
    candidateCount,
    droppedByDedup,
    warnings
  };
}
