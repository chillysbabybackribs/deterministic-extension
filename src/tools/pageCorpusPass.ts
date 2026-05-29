/**
 * Per-page overlay → corpus → grep pass (the ubiquitous spine).
 *
 * Whenever the pipeline opens or lands on a page, this runs the SAME core
 * routine the interaction fast-path uses: paint the actionable overlay, build
 * the element corpus, and (when a target is known) grep it deterministically.
 *
 *   - EXACT unique match  → caller may ACT on that element with no model.
 *   - SHORTLIST / NONE     → caller defers to the model, handing it the rendered
 *                            corpus summary so it plans the next step with the
 *                            page already mapped (never blind).
 *
 * This module owns NO model calls and makes NO decision about whether to act vs
 * defer — it only paints, captures, and greps. The caller (executePlan /
 * pipelineRunner) decides what to do with the outcome. Best-effort: an overlay
 * failure (unsupported page, injection blocked) returns a "skipped" outcome
 * rather than throwing, so a page-open never hard-fails on the overlay.
 */

import { showActionableOverlay, type ActionableElement, type OverlayCaptureResult } from "./elementOverlay";
import { buildCorpus, renderCandidate, searchCorpus } from "./elementCorpus";

export type PageCorpusOutcome =
  | {
      /** Overlay painted; corpus captured. Grep result included when a target was given. */
      kind: "captured";
      capture: OverlayCaptureResult;
      /** Unique exact element match for the target, when one exists. */
      exact?: ActionableElement;
      /** Up to K candidates for the model when there was no unique exact match. */
      shortlist: ActionableElement[];
      /** Compact, model-facing rendering of the page corpus + grep result. */
      summary: string;
    }
  | {
      /** Overlay could not run (e.g. chrome:// page, injection blocked). */
      kind: "skipped";
      reason: string;
    };

const DEFAULT_MAX_RENDER = 40;

/**
 * Run the overlay→corpus→grep pass on a tab (defaults to the active tab — which
 * is the page a page-opening tool just navigated to). `target`, when provided,
 * is greped over the corpus; omit it to just paint + map the page.
 */
export async function runPageCorpusPass(args: {
  tabId?: number;
  target?: string;
  maxRender?: number;
}): Promise<PageCorpusOutcome> {
  let capture: OverlayCaptureResult;
  try {
    capture = await showActionableOverlay(args.tabId);
  } catch (error) {
    return { kind: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }

  const corpus = buildCorpus(capture);
  const search = args.target ? searchCorpus(args.target, corpus) : undefined;
  const exact = search?.kind === "exact" ? search.winner : undefined;
  const shortlist = search?.kind === "exact" ? [search.winner] : search?.kind === "shortlist" ? search.candidates : [];

  return {
    kind: "captured",
    capture,
    exact,
    shortlist,
    summary: renderPageCorpus(capture, args.target, exact, shortlist, args.maxRender ?? DEFAULT_MAX_RENDER)
  };
}

/**
 * Render the captured corpus (and any grep result) as a compact numbered list,
 * so the model sees exactly what each overlay badge index is and which one
 * matched the target. Mirrors act_on_page's map rendering for consistency.
 */
function renderPageCorpus(
  capture: OverlayCaptureResult,
  target: string | undefined,
  exact: ActionableElement | undefined,
  shortlist: ActionableElement[],
  max: number
): string {
  const lines: string[] = [
    `Mapped ${capture.elements.length} actionable element(s) on ${capture.title || capture.url}.`
  ];

  if (target) {
    if (exact) {
      lines.push(`Exact match for "${target}": #${exact.index} ${describe(exact)}.`);
    } else if (shortlist.length) {
      lines.push(`No unique match for "${target}" — candidates (choose by overlayIndex):`);
      lines.push(...shortlist.map((el) => `  ${renderCandidate(el)}`));
    } else {
      lines.push(`No element matched "${target}".`);
    }
  }

  lines.push("Actionable map (index → element):");
  for (const el of capture.elements.slice(0, max)) {
    lines.push(`  ${renderCandidate(el)}`);
  }
  if (capture.elements.length > max) {
    lines.push(`  …and ${capture.elements.length - max} more.`);
  }

  return lines.join("\n");
}

function describe(el: ActionableElement): string {
  const name = el.accessibleName ? `"${el.accessibleName}"` : `the ${el.role ?? el.tagName}`;
  return `${name}${el.link ? ` (→ ${el.link.path})` : ""}`;
}
