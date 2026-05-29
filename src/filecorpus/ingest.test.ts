import { describe, expect, it } from "vitest";
import { ingestFile } from "./ingest";
import { rankUnits } from "./rankUnits";

function makeFile(name: string, content: string, type = ""): File {
  return new File([content], name, { type });
}

describe("ingestFile", () => {
  it("ingests a CSV into a queryable corpus", async () => {
    const csv = "Name,Role\nAda Lovelace,Mathematician\nGrace Hopper,Engineer";
    const corpus = await ingestFile(makeFile("people.csv", csv, "text/csv"));

    expect(corpus.sourceKind).toBe("csv");
    expect(corpus.unitCount).toBe(2);
    expect(corpus.fileName).toBe("people.csv");
    expect(corpus.index.n).toBe(2);

    const ranked = rankUnits(corpus, "Hopper");
    expect(ranked[0].unit.address.columns?.Name).toBe("Grace Hopper");
  });

  it("ingests markdown with heading paths", async () => {
    const md = "# Guide\n\nThe introduction paragraph is long enough to keep.\n\n## Setup\n\nThe setup section paragraph is also long enough to keep.";
    const corpus = await ingestFile(makeFile("guide.md", md));
    expect(corpus.sourceKind).toBe("markdown");
    const ranked = rankUnits(corpus, "setup", { neighborRadius: 0 });
    expect(ranked.some((item) => item.unit.address.headingPath?.includes("Setup"))).toBe(true);
  });

  it("assigns stable ids and ordinals", async () => {
    const corpus = await ingestFile(makeFile("a.csv", "H\nx\ny\nz"));
    expect(corpus.units.map((unit) => unit.ordinal)).toEqual([0, 1, 2]);
    expect(corpus.units[0].id).toBe(`${corpus.fileId}:u0`);
  });

  it("rejects unsupported file types", async () => {
    await expect(ingestFile(makeFile("image.png", "binary", "image/png"))).rejects.toThrow(
      /Unsupported file type/
    );
  });
});
