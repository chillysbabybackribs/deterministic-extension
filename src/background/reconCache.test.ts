import { describe, expect, it, vi } from "vitest";
import { ReconCache } from "./reconCache";
import type { SiteRecon } from "../tools/siteRecon";

function fakeRecon(origin: string, paths: string[]): SiteRecon {
  return {
    origin,
    paths: paths.map((p) => ({ url: `${origin}${p}`, path: p, source: "link" as const })),
    robots: { fetched: false, sitemaps: [], disallow: [], allow: [] },
    sitemapUrlCount: 0,
    warnings: []
  };
}

describe("ReconCache", () => {
  it("originOf accepts http(s), rejects chrome:// and invalid", () => {
    expect(ReconCache.originOf("https://x.com/a")).toBe("https://x.com");
    expect(ReconCache.originOf("http://localhost:3000/y")).toBe("http://localhost:3000");
    expect(ReconCache.originOf("chrome://extensions")).toBeUndefined();
    expect(ReconCache.originOf(undefined)).toBeUndefined();
  });

  it("runs once and caches per tab", async () => {
    const runner = vi.fn(async (_t: number, origin: string) => fakeRecon(origin, ["/a"]));
    const cache = new ReconCache(runner, () => 1000);
    await cache.maybeRun(7, "https://x.com/page");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(cache.get(7)?.origin).toBe("https://x.com");
    expect(cache.get(7)?.recon.paths[0].path).toBe("/a");
  });

  it("does NOT re-run for the same fresh origin", async () => {
    const runner = vi.fn(async (_t: number, origin: string) => fakeRecon(origin, []));
    let now = 1000;
    const cache = new ReconCache(runner, () => now);
    await cache.maybeRun(7, "https://x.com/p1");
    await cache.maybeRun(7, "https://x.com/p2"); // same origin, fresh
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("re-runs when the origin changes", async () => {
    const runner = vi.fn(async (_t: number, origin: string) => fakeRecon(origin, []));
    const cache = new ReconCache(runner, () => 1000);
    await cache.maybeRun(7, "https://x.com/p");
    await cache.maybeRun(7, "https://y.com/p"); // different origin
    expect(runner).toHaveBeenCalledTimes(2);
    expect(cache.get(7)?.origin).toBe("https://y.com");
  });

  it("re-runs when the cached entry is stale", async () => {
    const runner = vi.fn(async (_t: number, origin: string) => fakeRecon(origin, []));
    let now = 1000;
    const cache = new ReconCache(runner, () => now);
    await cache.maybeRun(7, "https://x.com/p");
    now += 11 * 60_000; // > STALE_MS (10 min)
    await cache.maybeRun(7, "https://x.com/p");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("drops the entry when navigating to a non-web URL", async () => {
    const runner = vi.fn(async (_t: number, origin: string) => fakeRecon(origin, []));
    const cache = new ReconCache(runner, () => 1000);
    await cache.maybeRun(7, "https://x.com/p");
    expect(cache.get(7)).toBeDefined();
    await cache.maybeRun(7, "chrome://settings");
    expect(cache.get(7)).toBeUndefined();
  });

  it("clearTab removes an entry", async () => {
    const cache = new ReconCache(async (_t, o) => fakeRecon(o, []), () => 1000);
    await cache.maybeRun(7, "https://x.com/p");
    cache.clearTab(7);
    expect(cache.get(7)).toBeUndefined();
  });

  it("dedupes concurrent triggers for the same tab", async () => {
    let resolve: (r: SiteRecon) => void = () => undefined;
    const runner = vi.fn(() => new Promise<SiteRecon>((res) => { resolve = res; }));
    const cache = new ReconCache(runner, () => 1000);
    const p1 = cache.maybeRun(7, "https://x.com/p");
    const p2 = cache.maybeRun(7, "https://x.com/p"); // in flight → no second run
    resolve(fakeRecon("https://x.com", []));
    await Promise.all([p1, p2]);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
