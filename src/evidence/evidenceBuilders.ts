import type { ToolFailureEvidence } from "./evidenceTypes";
import { makeId } from "../shared/id";

export function makeFailureEvidence(toolName: string, error: string, createdAt = new Date().toISOString()): ToolFailureEvidence {
  return {
    id: makeId("failure"),
    createdAt,
    type: "tool_failure",
    evidenceClass: "failed_capability",
    quality: "failed",
    summary: error,
    warnings: [error],
    toolName,
    error,
    provenance: {
      toolName,
      collectedAt: createdAt
    }
  };
}

export function makeUnavailableCapabilityEvidence(
  capability: string,
  error: string,
  createdAt = new Date().toISOString()
): ToolFailureEvidence {
  return {
    id: makeId("unavailable_capability"),
    createdAt,
    type: "tool_failure",
    evidenceClass: "unavailable_capability",
    quality: "failed",
    summary: error,
    warnings: [error],
    toolName: capability,
    error,
    provenance: {
      capability,
      collectedAt: createdAt
    }
  };
}
