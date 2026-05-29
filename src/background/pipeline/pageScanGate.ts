/**
 * Cheap, URL-free gate for the expensive initial page scan.
 *
 * The pre-planning overlay scan (buildPagePlanningContext / interaction fast-path
 * → showActionableOverlay) injects into the page, walks the DOM, and paints a
 * numbered badge on every actionable element. That is the slow part of a turn,
 * and it used to run on EVERY prompt — even a web-research prompt that has nothing
 * to do with the page you happen to be sitting on.
 *
 * The decision is made from the PROMPT ALONE (plus the cheap "did the user
 * capture UI" / "is this a web page" signals). We deliberately do NOT weigh the
 * current URL against the corpus: every page you visit is folded into the corpus
 * by the navigation listener, so "is this site known" is true for basically every
 * page you're on — it can never say skip. The right signal is simply: is the
 * prompt about THIS page, or is it research / something else?
 *
 *   - SCAN when the prompt is about the current page (deictic "this page", a click/
 *     type/scroll interaction, or an explicit captured UI selection).
 *   - SKIP otherwise — research/search prompts and self-contained asks go straight
 *     to the router/research path, which never needed the page map.
 *
 * Pure + unit-testable.
 */

export type PageScanDecision = {
  scan: boolean;
  /** Short reason for the activity log. */
  reason: string;
};

export type PageScanGateInput = {
  userMessage: string;
  /** Current tab URL, when known — only used to skip chrome:// / non-web pages. */
  url?: string;
  /**
   * The user captured/selected UI on the current page for this request — an
   * explicit "act on THIS page" signal, so we always scan when set.
   */
  hasActiveCaptureContext?: boolean;
};

/** Decide whether to run the expensive overlay scan on the current page. */
export function shouldScanCurrentPage(input: PageScanGateInput): PageScanDecision {
  // A captured UI context means the user explicitly selected something on this
  // page to act on — always scan.
  if (input.hasActiveCaptureContext) {
    return { scan: true, reason: "captured UI context for the current page" };
  }

  // A chrome-internal / non-web page can't be scanned.
  if (input.url && !/^https?:\/\//i.test(input.url)) {
    return { scan: false, reason: "not a web page" };
  }

  // Research / web-search prompts never need the current page — go straight to
  // the router/research path (which navigates to the search step itself).
  if (looksLikeWebResearch(input.userMessage)) {
    return { scan: false, reason: "web-research task — going straight to search" };
  }

  // The prompt is about THIS page (deictic "this page", or a page interaction).
  if (looksLikeCurrentPagePrompt(input.userMessage)) {
    return { scan: true, reason: "prompt targets the current page" };
  }

  // Otherwise the prompt isn't about the current page — skip the scan.
  return { scan: false, reason: "prompt not about the current page" };
}

/** Explicit web/search/research framing — the page in front of the user is irrelevant. */
function looksLikeWebResearch(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(search (the )?web|google|look ?up|research|find (online|out)|on the (web|internet)|latest|compare\b.*\b(vs|versus|or)\b)\b/.test(text);
}

/** Deictic "this/current page", or a page-interaction/read intent. */
function looksLikeCurrentPagePrompt(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  // Explicit reference to the current page/site/tab.
  if (/\b(this|current|active|the open)\s+(page|site|website|tab|form|screen|article|post|video)\b/.test(text)) {
    return true;
  }
  // A direct page-interaction verb signals acting on the page in front of the
  // user (e.g. "click the login button", "scroll to pricing", "fill the form").
  if (/\b(click|tap|type into|fill|select|submit|scroll|press)\b/.test(text)) {
    return true;
  }
  // A read/analyze verb paired with a deictic ("summarize this", "read it").
  const deictic = /\b(this|that|these|those|here|it)\b/.test(text);
  const readVerb = /\b(read|summari[sz]e|analy[sz]e|describe|inspect|extract|understand)\b/.test(text);
  return deictic && readVerb;
}
