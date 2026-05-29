import { describe, expect, it } from "vitest";
import {
  buildSiteRecon,
  dedupePaths,
  foldHarvest,
  parseRobots,
  parseSitemap,
  renderSiteRecon
} from "./siteRecon";

describe("parseRobots", () => {
  it("extracts sitemaps, disallow, allow; ignores comments/blanks", () => {
    const txt = [
      "# comment",
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /api/private",
      "Allow: /api/public",
      "",
      "Sitemap: https://x.com/sitemap.xml",
      "Sitemap: https://x.com/news-sitemap.xml"
    ].join("\n");
    const r = parseRobots(txt);
    expect(r.sitemaps).toEqual(["https://x.com/sitemap.xml", "https://x.com/news-sitemap.xml"]);
    expect(r.disallow).toEqual(["/admin", "/api/private"]);
    expect(r.allow).toEqual(["/api/public"]);
  });
});

describe("parseSitemap", () => {
  it("parses a urlset into locs", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>`;
    const r = parseSitemap(xml);
    expect(r.isIndex).toBe(false);
    expect(r.locs).toEqual(["https://x.com/a", "https://x.com/b"]);
  });

  it("detects a sitemap index", () => {
    const xml = `<sitemapindex><sitemap><loc>https://x.com/sm1.xml</loc></sitemap><sitemap><loc>https://x.com/sm2.xml</loc></sitemap></sitemapindex>`;
    const r = parseSitemap(xml);
    expect(r.isIndex).toBe(true);
    expect(r.locs).toEqual(["https://x.com/sm1.xml", "https://x.com/sm2.xml"]);
  });
});

describe("foldHarvest + dedupePaths", () => {
  it("keeps same-origin links/forms/endpoints, drops cross-origin, dedupes by path", () => {
    const folded = foldHarvest({
      origin: "https://x.com",
      hrefs: ["https://x.com/a", "https://x.com/a", "https://other.com/z", "https://x.com/b"],
      formActions: ["https://x.com/submit"],
      observedEndpoints: ["https://x.com/api/data", "https://cdn.other.com/x.js"]
    });
    const paths = dedupePaths(folded).map((p) => p.path);
    expect(paths).toEqual(["/a", "/api/data", "/b", "/submit"]); // sorted, deduped, same-origin only
  });
});

describe("buildSiteRecon (injected fetch — no network)", () => {
  const robots = "Disallow: /admin\nSitemap: https://x.com/sitemap.xml";
  const sitemap = `<urlset><url><loc>https://x.com/pricing</loc></url><url><loc>https://x.com/docs</loc></url></urlset>`;

  it("folds harvest + robots + sitemap into one inventory (incl. /admin discovery)", async () => {
    const fetchImpl = async (url: string) => {
      if (url === "https://x.com/robots.txt") return robots;
      if (url === "https://x.com/sitemap.xml") return sitemap;
      return undefined;
    };
    const recon = await buildSiteRecon({
      harvest: { origin: "https://x.com", hrefs: ["https://x.com/", "https://x.com/login"], formActions: [] },
      fetchImpl
    });
    const paths = recon.paths.map((p) => p.path);
    expect(recon.robots.fetched).toBe(true);
    expect(recon.robots.sitemaps).toEqual(["https://x.com/sitemap.xml"]);
    // /admin (a login page) is DISCOVERED and recorded — mapping, not intrusion.
    expect(paths).toContain("/admin");
    expect(paths).toContain("/login");
    expect(paths).toContain("/pricing");
    expect(paths).toContain("/docs");
    expect(recon.sitemapUrlCount).toBe(2);
  });

  it("recurses a sitemap index one level", async () => {
    const index = `<sitemapindex><sitemap><loc>https://x.com/sm-a.xml</loc></sitemap></sitemapindex>`;
    const child = `<urlset><url><loc>https://x.com/from-index</loc></url></urlset>`;
    const fetchImpl = async (url: string) => {
      if (url === "https://x.com/robots.txt") return "Sitemap: https://x.com/sitemap.xml";
      if (url === "https://x.com/sitemap.xml") return index;
      if (url === "https://x.com/sm-a.xml") return child;
      return undefined;
    };
    const recon = await buildSiteRecon({ harvest: { origin: "https://x.com", hrefs: [], formActions: [] }, fetchImpl });
    expect(recon.paths.map((p) => p.path)).toContain("/from-index");
  });

  it("degrades gracefully when robots/sitemap are absent", async () => {
    const recon = await buildSiteRecon({
      harvest: { origin: "https://x.com", hrefs: ["https://x.com/only"], formActions: [] },
      fetchImpl: async () => undefined
    });
    expect(recon.robots.fetched).toBe(false);
    expect(recon.warnings).toContain("robots.txt not reachable.");
    expect(recon.paths.map((p) => p.path)).toEqual(["/only"]); // harvest still works
  });

  it("renders a compact site map", async () => {
    const recon = await buildSiteRecon({
      harvest: { origin: "https://x.com", hrefs: ["https://x.com/a"], formActions: [] },
      fetchImpl: async () => undefined
    });
    const text = renderSiteRecon(recon);
    expect(text).toContain("Site map for https://x.com");
    expect(text).toContain("/a [link]");
  });
});
