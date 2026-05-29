import { describe, expect, it } from "vitest";
import {
  grepRecords,
  getExtractions,
  grepExtractions,
  type ExtractionRecord
} from "./extractionStore";

function record(overrides: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    key: "t1:1",
    taskId: "t1",
    seq: 1,
    tool: "understand_page",
    status: "success",
    summary: "s",
    fullExtraction: {},
    savedAtMs: 0,
    ...overrides
  };
}

describe("grepRecords (Tier-1 recovery)", () => {
  it("finds matching values deep in the extraction with a path trail", () => {
    const recs = [record({
      fullExtraction: {
        inspection: {
          network: {
            resources: [
              { url: "https://api.example.com/v1/login" },
              { url: "https://api.example.com/v1/items" }
            ]
          }
        }
      }
    })];
    const matches = grepRecords(recs, "login");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toContain("login");
    expect(matches[0].path).toBe("inspection.network.resources[0].url");
    expect(matches[0].tool).toBe("understand_page");
  });

  it("is case-insensitive and matches numbers/booleans", () => {
    const recs = [record({ fullExtraction: { count: 42, ok: true, name: "GraphQL" } })];
    expect(grepRecords(recs, "graphql")).toHaveLength(1);
    expect(grepRecords(recs, "42")).toHaveLength(1);
    expect(grepRecords(recs, "true")).toHaveLength(1);
  });

  it("filters by tool", () => {
    const recs = [
      record({ tool: "understand_page", fullExtraction: { a: "match-here" } }),
      record({ key: "t1:2", seq: 2, tool: "capture_network", fullExtraction: { b: "match-here" } })
    ];
    const onlyNetwork = grepRecords(recs, "match-here", { tool: "capture_network" });
    expect(onlyNetwork).toHaveLength(1);
    expect(onlyNetwork[0].tool).toBe("capture_network");
  });

  it("respects maxMatches", () => {
    const recs = [record({ fullExtraction: { items: Array.from({ length: 50 }, () => "needle") } })];
    expect(grepRecords(recs, "needle", { maxMatches: 5 })).toHaveLength(5);
  });

  it("returns nothing for an empty query", () => {
    expect(grepRecords([record({ fullExtraction: { a: "x" } })], "  ")).toEqual([]);
  });

  it("clips very long matching values", () => {
    const recs = [record({ fullExtraction: { blob: "x".repeat(2000) + "needle" } })];
    const m = grepRecords(recs, "needle");
    expect(m).toHaveLength(1);
    expect(m[0].value.length).toBeLessThanOrEqual(501);
  });
});

describe("IndexedDB-unavailable graceful behavior (node env, no indexedDB)", () => {
  it("getExtractions returns [] without throwing", async () => {
    await expect(getExtractions("nope")).resolves.toEqual([]);
  });
  it("grepExtractions returns [] without throwing", async () => {
    await expect(grepExtractions("nope", "anything")).resolves.toEqual([]);
  });
});
