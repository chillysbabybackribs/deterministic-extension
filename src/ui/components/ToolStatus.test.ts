import { describe, expect, it } from "vitest";
import { formatActivityDiagnostics } from "./ToolStatus";
import type { ExecutionLogEntry } from "../../execution/executionTypes";

describe("formatActivityDiagnostics", () => {
  it("formats latency and token usage compactly", () => {
    const entry: ExecutionLogEntry = {
      id: "log_1",
      timestamp: "2026-05-11T00:00:00.000Z",
      level: "info",
      label: "Haiku 4.5",
      status: "completed",
      durationMs: 1250,
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        totalTokens: 1290
      }
    };

    expect(formatActivityDiagnostics(entry)).toBe("1.3s · 1,234 in / 56 out");
  });

  it("omits diagnostics when no measured fields are present", () => {
    const entry: ExecutionLogEntry = {
      id: "log_2",
      timestamp: "2026-05-11T00:00:00.000Z",
      level: "info",
      label: "Browser"
    };

    expect(formatActivityDiagnostics(entry)).toBe("");
  });
});
