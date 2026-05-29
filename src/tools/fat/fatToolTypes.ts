/**
 * Fat tools — the deterministic execution library the model planner composes.
 *
 * A "fat tool" groups many fine-grained deterministic tools into one
 * domain-level operation. Because deterministic tools are free (the model only
 * ever sees the summary), gatherer fat tools run EVERYTHING in their domain to
 * collect maximum information first, then emit a COMPACT summary for the model.
 *
 * Each fat tool returns a {@link FatToolResult}:
 *   - summary:        compact, context-safe text the model reads.
 *   - fullExtraction: the complete gathered data (kept for the persistence +
 *                     grep layer that lands in the next phase; never sent to the
 *                     model wholesale).
 *
 * Two kinds of fat tool:
 *   - gather-max  (understand_page, capture_network, search_web, read_workspace):
 *                 gather as much as possible; summary is a compression of it.
 *   - intent      (act_on_page, write_workspace): perform a specific requested
 *                 action; "gather everything" doesn't apply to irreversible ops.
 */

export type FatToolName =
  | "understand_page"
  | "capture_network"
  | "inspect_runtime"
  | "search_web"
  | "read_workspace"
  | "query_file"
  | "act_on_page"
  | "write_workspace";

export type FatToolStatus = "success" | "partial" | "failed";

export type FatToolResult = {
  tool: FatToolName;
  status: FatToolStatus;
  /** Compact, context-safe text — the only thing the model reads. */
  summary: string;
  /**
   * The complete gathered data for this run. Held for the persistence/grep
   * layer (IndexedDB + optional workspace file). NOT sent to the model in full.
   */
  fullExtraction: Record<string, unknown>;
  warnings: string[];
  error?: string;
  /**
   * Optional structured signals for the pipeline (not shown to the model as part
   * of the summary). `blocked` marks a result that cannot be improved by
   * re-running the same tool — the pipeline should fast-fail with `blockedReason`
   * rather than replan. Used today by capture_network when deep capture is off.
   */
  meta?: {
    blocked?: boolean;
    blockedReason?: string;
    /**
     * Set when this step hit a wall an opt-in local companion could clear (e.g.
     * response bodies blocked by the page CSP, which a companion-owned headless
     * browser with CDP would capture). Drives the opt-in pill. capability names
     * match protocol.CapabilityName.
     */
    capabilityGap?: {
      capability: "full_network_capture" | "local_filesystem" | "local_process";
      reason: string;
    };
  };
};

/** Max chars any fat-tool summary may contribute to model context. */
export const FAT_SUMMARY_MAX_CHARS = 24_000;

/** Clip a summary to the context-safe budget with a visible truncation marker. */
export function clipSummary(text: string, max = FAT_SUMMARY_MAX_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars — full data is in the extraction store]`
    : text;
}

/** Join summary sections, dropping empties, and clip to the budget. */
export function buildSummary(sections: Array<string | undefined>): string {
  return clipSummary(sections.filter((section): section is string => Boolean(section && section.trim())).join("\n"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
