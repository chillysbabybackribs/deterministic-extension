import { describe, expect, it } from "vitest";
import { ingestFolder, TrickleController, type FolderTextFile } from "./ingestFolder";
import { rankUnits } from "./rankUnits";

function files(n: number, prefix = "f"): FolderTextFile[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `dir/${prefix}${i}.md`,
    name: `${prefix}${i}.md`,
    text: `# Heading ${i}\n\nThis is a sufficiently long paragraph in file number ${i} about widgets.`
  }));
}

describe("ingestFolder", () => {
  it("tags every unit with its source file path", async () => {
    const { initial, done } = await ingestFolder({
      files: [{ path: "src/auth/login.ts", name: "login.ts", text: "export function login() { return doAuth(); }" }],
      rootName: "proj"
    });
    await done;
    expect(initial.sourceType).toBe("folder");
    expect(initial.fileName).toBe("proj");
    expect(initial.units.every((u) => u.address.path === "src/auth/login.ts")).toBe(true);
    const ranked = rankUnits(initial, "login", { neighborRadius: 0 });
    expect(ranked[0].unit.address.path).toBe("src/auth/login.ts");
  });

  it("ingests a small folder fully in the first slice (no trickle needed)", async () => {
    const { initial, done } = await ingestFolder({ files: files(5), rootName: "small" });
    const final = await done;
    expect(initial.building).toBe(false);
    expect(final.fileCount).toBe(5);
    expect(final.building).toBe(false);
  });

  it("returns a usable first slice immediately for a large folder, then trickles the rest", async () => {
    const all = files(120);
    const updates: number[] = [];
    const { initial, done } = await ingestFolder({
      files: all,
      rootName: "big",
      onUpdate: (corpus) => {
        updates.push(corpus.fileCount ?? 0);
      }
    });

    // First slice is capped and marked building.
    expect(initial.building).toBe(true);
    expect(initial.fileCount).toBeLessThanOrEqual(40);
    expect(initial.unitCount).toBeGreaterThan(0);

    const final = await done;
    expect(final.fileCount).toBe(120);
    expect(final.building).toBe(false);
    // The whole corpus is queryable after the trickle completes.
    const ranked = rankUnits(final, "file number 119", { neighborRadius: 0 });
    expect(ranked.length).toBeGreaterThan(0);
    // onUpdate fired during the trickle (progress grew).
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toBe(120);
  });

  it("stops the trickle when the signal aborts", async () => {
    const controller = new TrickleController();
    const signal = controller.start();
    const { initial, done } = await ingestFolder({ files: files(300), rootName: "abortme", signal });
    expect(initial.building).toBe(true);
    controller.abort();
    const final = await done;
    // Aborted before finishing all 300 files.
    expect(final.fileCount).toBeLessThan(300);
    expect(final.building).toBe(false);
  });

  it("keeps the index consistent with the units after trickling (queryable mid-tail)", async () => {
    const { done } = await ingestFolder({ files: files(80), rootName: "idx" });
    const final = await done;
    expect(final.index.n).toBe(final.units.length);
    // A term only in a late file must be findable (proves extendIndex ran).
    const ranked = rankUnits(final, "file number 75", { neighborRadius: 0 });
    expect(ranked.some((r) => r.unit.address.path === "dir/f75.md")).toBe(true);
  });
});
