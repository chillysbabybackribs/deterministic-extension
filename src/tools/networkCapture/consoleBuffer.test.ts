import { describe, expect, it } from "vitest";
import {
  addConsoleEntry,
  buildConsoleSummary,
  createConsoleBuffer,
  type CapturedConsoleEntry,
  type ConsoleBuffer
} from "./consoleBuffer";

let seq = 0;
function entry(overrides: Partial<CapturedConsoleEntry>): CapturedConsoleEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    kind: "console",
    level: "log",
    atMs: seq,
    message: "msg",
    ...overrides
  };
}

function bufferWith(entries: CapturedConsoleEntry[]): ConsoleBuffer {
  const buffer = createConsoleBuffer(900 + seq);
  for (const e of entries) {
    addConsoleEntry(buffer, e);
  }
  return buffer;
}

describe("buildConsoleSummary", () => {
  it("defaults to errors + warnings and suppresses info/debug/log", () => {
    const buffer = bufferWith([
      entry({ level: "error", message: "boom" }),
      entry({ level: "warn", message: "careful" }),
      entry({ level: "info", message: "fyi" }),
      entry({ level: "debug", message: "dbg" }),
      entry({ level: "log", message: "noise" })
    ]);
    const summary = buildConsoleSummary(buffer, []);
    expect(summary.errorCount).toBe(1);
    expect(summary.warnCount).toBe(1);
    expect(summary.suppressedCount).toBe(3);
    expect(summary.otherLevels).toHaveLength(0);
  });

  it("includes extra levels when requested", () => {
    const buffer = bufferWith([
      entry({ level: "error", message: "boom" }),
      entry({ level: "info", message: "fyi" })
    ]);
    const summary = buildConsoleSummary(buffer, ["info"]);
    expect(summary.suppressedCount).toBe(0);
    expect(summary.otherLevels.map((g) => g.message)).toContain("fyi");
  });

  it("dedupes by signature and counts repeats", () => {
    const buffer = bufferWith([
      entry({ level: "error", message: "same error" }),
      entry({ level: "error", message: "same error" }),
      entry({ level: "error", message: "same error" })
    ]);
    const summary = buildConsoleSummary(buffer, []);
    expect(summary.errorCount).toBe(3);
    expect(summary.uniqueErrorCount).toBe(1);
    expect(summary.consoleErrors).toHaveLength(1);
    expect(summary.consoleErrors[0].count).toBe(3);
  });

  it("separates page errors from console.error calls", () => {
    const buffer = bufferWith([
      entry({ kind: "page-error", level: "error", message: "uncaught X" }),
      entry({ kind: "console", level: "error", message: "logged Y" })
    ]);
    const summary = buildConsoleSummary(buffer, []);
    expect(summary.pageErrors).toHaveLength(1);
    expect(summary.consoleErrors).toHaveLength(1);
    expect(summary.errorCount).toBe(2);
    expect(summary.uniqueErrorCount).toBe(2);
  });

  it("orders groups most-recent first", () => {
    const buffer = bufferWith([
      entry({ level: "error", message: "old", atMs: 10 }),
      entry({ level: "error", message: "new", atMs: 99 })
    ]);
    const summary = buildConsoleSummary(buffer, []);
    expect(summary.consoleErrors[0].message).toBe("new");
  });

  it("always shows page errors regardless of requested levels", () => {
    const buffer = bufferWith([
      entry({ kind: "page-error", level: "error", message: "crash" })
    ]);
    const summary = buildConsoleSummary(buffer, ["log"]);
    expect(summary.pageErrors).toHaveLength(1);
    expect(summary.errorCount).toBe(1);
  });
});
