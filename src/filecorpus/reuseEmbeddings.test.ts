import { describe, expect, it } from "vitest";
import type { FileCorpus, FileUnit } from "./corpusTypes";
import { applyReusedEmbeddings, buildReuseIndex } from "./reuseEmbeddings";

function unit(ordinal: number, text: string, embedding?: number[]): FileUnit {
  return { id: `f:u${ordinal}`, ordinal, kind: "paragraph", text, address: {}, structure: {}, embedding };
}

function corpus(units: FileUnit[]): FileCorpus {
  return {
    fileId: "f",
    fileName: "demo",
    sourceType: "folder",
    byteSize: 0,
    ingestedAt: "2026-05-29T00:00:00.000Z",
    unitCount: units.length,
    warnings: [],
    units,
    index: { n: units.length, df: {}, tf: {} }
  };
}

const DIM = 1536;
const vec = (seed: number) => Array.from({ length: DIM }, (_, i) => (i === 0 ? seed : 0));

describe("buildReuseIndex", () => {
  it("indexes embedded units by trimmed text and records the dimension", () => {
    const idx = buildReuseIndex(corpus([unit(0, "  hello  ", vec(1)), unit(1, "world", vec(2)), unit(2, "no vec")]));
    expect(idx.dimensions).toBe(DIM);
    expect(idx.byText.get("hello")).toEqual(vec(1));
    expect(idx.byText.has("no vec")).toBe(false);
  });

  it("is empty for an undefined prior corpus", () => {
    const idx = buildReuseIndex(undefined);
    expect(idx.byText.size).toBe(0);
    expect(idx.dimensions).toBe(0);
  });
});

describe("applyReusedEmbeddings", () => {
  it("reuses vectors for unchanged text and leaves new text for the embedder", () => {
    const prior = buildReuseIndex(corpus([unit(0, "unchanged", vec(7))]));
    const fresh = [unit(0, "unchanged"), unit(1, "brand new")];
    const { units, reused } = applyReusedEmbeddings(fresh, prior, DIM);
    expect(reused).toBe(1);
    expect(units[0].embedding).toEqual(vec(7)); // reused, no API call needed
    expect(units[1].embedding).toBeUndefined(); // will be embedded
  });

  it("does NOT reuse when the prior dimension differs (e.g. old 3072 corpus)", () => {
    const old3072 = buildReuseIndex(corpus([unit(0, "x", Array.from({ length: 3072 }, () => 0.1))]));
    const fresh = [unit(0, "x")];
    const { units, reused } = applyReusedEmbeddings(fresh, old3072, DIM);
    expect(reused).toBe(0);
    expect(units[0].embedding).toBeUndefined(); // re-embedded at the new dimension
  });

  it("never overwrites a unit that already has a vector", () => {
    const prior = buildReuseIndex(corpus([unit(0, "x", vec(1))]));
    const fresh = [unit(0, "x", vec(9))];
    const { units, reused } = applyReusedEmbeddings(fresh, prior, DIM);
    expect(reused).toBe(0);
    expect(units[0].embedding).toEqual(vec(9));
  });

  it("is a no-op with no reuse index", () => {
    const fresh = [unit(0, "x")];
    const { units, reused } = applyReusedEmbeddings(fresh, undefined, DIM);
    expect(reused).toBe(0);
    expect(units).toBe(fresh);
  });
});
