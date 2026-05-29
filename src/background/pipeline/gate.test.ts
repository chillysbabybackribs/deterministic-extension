import { describe, expect, it } from "vitest";
import { parseGate } from "./gate";

const fb = { priorAccumulator: "prior", newSummary: "new" };

describe("parseGate", () => {
  it("parses a synthesize decision and uses the model's merged accumulator", () => {
    const r = parseGate(JSON.stringify({ decision: "synthesize", accumulator: "merged text", missing: "" }), fb);
    expect(r.decision).toBe("synthesize");
    expect(r.accumulator).toBe("merged text");
    expect(r.missing).toBe("");
  });

  it("parses a grep decision with a query", () => {
    const r = parseGate(JSON.stringify({ decision: "grep", accumulator: "m", missing: "the auth header", grepQuery: "authorization" }), fb);
    expect(r.decision).toBe("grep");
    expect(r.grepQuery).toBe("authorization");
  });

  it("downgrades grep-without-query to replan", () => {
    const r = parseGate(JSON.stringify({ decision: "grep", accumulator: "m", missing: "x" }), fb);
    expect(r.decision).toBe("replan");
    expect(r.grepQuery).toBeUndefined();
  });

  it("parses replan", () => {
    const r = parseGate(JSON.stringify({ decision: "replan", accumulator: "m", missing: "need pricing page" }), fb);
    expect(r.decision).toBe("replan");
    expect(r.missing).toBe("need pricing page");
  });

  it("falls back to synthesize with concatenated summaries on bad JSON", () => {
    const r = parseGate("not json", fb);
    expect(r.decision).toBe("synthesize");
    expect(r.accumulator).toBe("prior\n\nnew");
  });

  it("uses fallback accumulator when model omits it", () => {
    const r = parseGate(JSON.stringify({ decision: "synthesize" }), fb);
    expect(r.accumulator).toBe("prior\n\nnew");
  });
});
