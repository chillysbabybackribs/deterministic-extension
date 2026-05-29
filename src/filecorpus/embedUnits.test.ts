import { describe, expect, it, vi } from "vitest";
import type { FileUnit } from "./corpusTypes";
import { embedUnits } from "./embedUnits";

function unit(ordinal: number, text: string, embedding?: number[]): FileUnit {
  return { id: `f:u${ordinal}`, ordinal, kind: "paragraph", text, address: {}, structure: {}, embedding };
}

describe("embedUnits", () => {
  it("returns units unchanged with no embedder (graceful degrade to lexical)", async () => {
    const units = [unit(0, "a"), unit(1, "b")];
    const out = await embedUnits(units, undefined);
    expect(out.embedded).toBe(0);
    expect(out.units).toBe(units); // same reference — untouched
    expect(out.units[0].embedding).toBeUndefined();
  });

  it("embeds every not-yet-embedded, non-empty unit and aligns vectors by index", async () => {
    const units = [unit(0, "alpha"), unit(1, "beta")];
    const embed = vi.fn(async (texts: string[]) => texts.map((_, i) => [i, i + 1]));
    const out = await embedUnits(units, embed);
    expect(embed).toHaveBeenCalledWith(["alpha", "beta"]);
    expect(out.embedded).toBe(2);
    expect(out.units[0].embedding).toEqual([0, 1]);
    expect(out.units[1].embedding).toEqual([1, 2]);
  });

  it("only sends units missing a vector — idempotent over a partially embedded corpus", async () => {
    const units = [unit(0, "already", [9, 9]), unit(1, "new")];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 1]));
    const out = await embedUnits(units, embed);
    expect(embed).toHaveBeenCalledWith(["new"]); // the embedded one is not re-sent
    expect(out.embedded).toBe(1);
    expect(out.units[0].embedding).toEqual([9, 9]); // preserved
    expect(out.units[1].embedding).toEqual([1, 1]);
  });

  it("skips empty/whitespace units (nothing to embed)", async () => {
    const units = [unit(0, "   "), unit(1, "real")];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    const out = await embedUnits(units, embed);
    expect(embed).toHaveBeenCalledWith(["real"]);
    expect(out.units[0].embedding).toBeUndefined();
    expect(out.units[1].embedding).toEqual([1]);
  });

  it("returns units untouched with a warning when the embedder throws (never breaks ingest)", async () => {
    const units = [unit(0, "x")];
    const embed = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const out = await embedUnits(units, embed);
    expect(out.embedded).toBe(0);
    expect(out.units[0].embedding).toBeUndefined();
    expect(out.warning).toContain("quota exceeded");
  });

  it("warns and skips on a mismatched vector count", async () => {
    const units = [unit(0, "a"), unit(1, "b")];
    const embed = vi.fn(async () => [[1, 2]]); // 1 vector for 2 inputs
    const out = await embedUnits(units, embed);
    expect(out.embedded).toBe(0);
    expect(out.warning).toContain("mismatched");
  });

  it("does nothing when all units are already embedded", async () => {
    const units = [unit(0, "a", [1]), unit(1, "b", [2])];
    const embed = vi.fn(async () => []);
    const out = await embedUnits(units, embed);
    expect(embed).not.toHaveBeenCalled();
    expect(out.embedded).toBe(0);
  });
});
