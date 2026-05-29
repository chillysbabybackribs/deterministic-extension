import { describe, expect, it } from "vitest";
import type { RunProgressEvent } from "../../shared/protocol";
import { progressPanelTitle } from "./ResearchProgressCard";

describe("progressPanelTitle", () => {
  it("uses a generic title for browser and model execution progress", () => {
    expect(progressPanelTitle([
      progressEvent("Model turn"),
      progressEvent("Browser extract")
    ])).toBe("Progress");
  });

  it("keeps the research title for research-only progress", () => {
    expect(progressPanelTitle([
      progressEvent("Query"),
      progressEvent("Sufficiency")
    ])).toBe("Research");
  });
});

function progressEvent(label: string): RunProgressEvent {
  return {
    id: `progress-${label}`,
    timestamp: "2026-05-12T00:00:00.000Z",
    level: "info",
    label,
    detail: "test",
    status: "running"
  };
}
