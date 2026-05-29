import { describe, expect, it, vi } from "vitest";
import { ingestFolder, TrickleController, type FolderTextFile } from "./ingestFolder";
import { rankUnits } from "./rankUnits";

/** A fake embedder: a fixed-length vector per text, so we can assert coverage. */
const fakeEmbed = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map((_, i) => [i, 1, 0]));

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

  it("embeds the first slice synchronously so the initial corpus is semantic", async () => {
    const { initial, done } = await ingestFolder({ files: files(3), rootName: "emb", embed: fakeEmbed });
    await done;
    expect(initial.units.length).toBeGreaterThan(0);
    expect(initial.units.every((u) => Array.isArray(u.embedding) && u.embedding.length === 3)).toBe(true);
  });

  it("embeds units as they trickle in, so the final corpus is fully embedded", async () => {
    const embed = vi.fn(fakeEmbed);
    const { done } = await ingestFolder({ files: files(120), rootName: "big", embed });
    const final = await done;
    expect(final.fileCount).toBe(120);
    expect(final.units.every((u) => Array.isArray(u.embedding))).toBe(true);
    expect(embed).toHaveBeenCalled(); // embedding ran across batches, not just once
  });

  it("falls back to lexical (no embeddings, with a warning) when the embedder throws", async () => {
    const embed = vi.fn(async () => {
      throw new Error("no key");
    });
    const { initial, done } = await ingestFolder({ files: files(4), rootName: "degrade", embed });
    const final = await done;
    expect(final.units.some((u) => u.embedding)).toBe(false);
    expect(initial.warnings.some((w) => w.includes("keyword"))).toBe(true);
    // Still fully indexed + queryable lexically.
    expect(rankUnits(final, "widgets", { neighborRadius: 0 }).length).toBeGreaterThan(0);
  });

  it("reuses prior vectors for unchanged files on reconnect (skips re-embedding)", async () => {
    const { buildReuseIndex } = await import("./reuseEmbeddings");
    // 1536-dim fake embedder so reuse-dimension matching applies.
    const dimEmbed = (texts: string[]) => Promise.resolve(texts.map(() => Array.from({ length: 1536 }, () => 0.5)));

    // First connect: full embed.
    const first = await ingestFolder({ files: files(5), rootName: "proj", embed: vi.fn(dimEmbed) });
    const firstFinal = await first.done;
    expect(firstFinal.units.every((u) => u.embedding?.length === 1536)).toBe(true);

    // Reconnect the SAME files: reuse should make the embedder unnecessary.
    const reuse = buildReuseIndex(firstFinal);
    const embedSpy = vi.fn(dimEmbed);
    const second = await ingestFolder({ files: files(5), rootName: "proj", embed: embedSpy, reuse });
    const secondFinal = await second.done;
    expect(secondFinal.units.every((u) => u.embedding?.length === 1536)).toBe(true);
    expect(embedSpy).not.toHaveBeenCalled(); // every unit reused — zero API calls
  });

  it("with no embedder, units carry no vectors (lexical-only, unchanged behavior)", async () => {
    const { done } = await ingestFolder({ files: files(3), rootName: "noembed" });
    const final = await done;
    expect(final.units.every((u) => u.embedding === undefined)).toBe(true);
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
