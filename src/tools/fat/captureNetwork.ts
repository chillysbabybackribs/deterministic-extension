/**
 * Fat tool: capture_network (gather-max).
 *
 * Thin wrapper over the existing deterministic network-capture runner
 * (attach -> reload -> settle -> summarize). Returns the compact endpoint/auth
 * summary for the model and the full capture bundle as fullExtraction.
 */

import {
  formatDeterministicNetworkCaptureForLlm,
  runDeterministicNetworkCapturePreflight
} from "../../background/deterministicNetworkCaptureRunner";
import type { FatToolResult, FatToolStatus } from "./fatToolTypes";

export type CaptureNetworkInput = {
  tabId?: number;
};

export async function runCaptureNetworkFat(input: CaptureNetworkInput = {}): Promise<FatToolResult> {
  const preflight = await runDeterministicNetworkCapturePreflight({
    userMessage: "Capture and summarize this page's network traffic.",
    tabId: input.tabId
  });
  const bundle = preflight.bundle;

  const status: FatToolStatus =
    bundle.status === "completed" ? "success" : bundle.status === "partial" ? "partial" : "failed";

  return {
    tool: "capture_network",
    status,
    summary: formatDeterministicNetworkCaptureForLlm(bundle),
    fullExtraction: { bundle },
    warnings: bundle.warnings,
    error: bundle.status === "failed" ? bundle.errors[0] : undefined,
    meta: buildMeta(bundle)
  };
}

function buildMeta(bundle: { captureBlocked: boolean; blockedReason: string; bodiesUnobtainable: boolean }): FatToolResult["meta"] {
  if (bundle.captureBlocked) {
    return { blocked: true, blockedReason: bundle.blockedReason };
  }
  // Inventory captured, but response bodies were unobtainable in-browser (CSP
  // blocked the shim; webRequest can't read bodies). A companion-owned headless
  // browser with CDP would get them — raise the capability gap for the pill.
  if (bundle.bodiesUnobtainable) {
    return {
      capabilityGap: {
        capability: "full_network_capture",
        reason: "This page blocks in-browser capture of response bodies; a local engine could capture the full API responses."
      }
    };
  }
  return undefined;
}
