import { describe, expect, it } from "vitest";
import { shouldScanCurrentPage } from "./pageScanGate";

describe("shouldScanCurrentPage", () => {
  it("always scans when there is a captured UI context", () => {
    const d = shouldScanCurrentPage({ userMessage: "click the selected button", hasActiveCaptureContext: true });
    expect(d.scan).toBe(true);
    expect(d.reason).toContain("captured UI context");
  });

  it("skips a non-web (chrome://) page", () => {
    expect(shouldScanCurrentPage({ userMessage: "summarize this page", url: "chrome://newtab" }).scan).toBe(false);
  });

  it("scans when the prompt targets the current page", () => {
    expect(shouldScanCurrentPage({ userMessage: "summarize this page", url: "https://x.test/a" }).scan).toBe(true);
    expect(shouldScanCurrentPage({ userMessage: "click the login button", url: "https://x.test/a" }).scan).toBe(true);
    expect(shouldScanCurrentPage({ userMessage: "what does this site do", url: "https://x.test/a" }).scan).toBe(true);
    expect(shouldScanCurrentPage({ userMessage: "scroll to the pricing section" }).scan).toBe(true);
  });

  it("SKIPS web-research prompts regardless of the current page (the core fix)", () => {
    const d = shouldScanCurrentPage({
      userMessage:
        "research how Playwright, Puppeteer, and Selenium differ for browser automation and which is best for a Chrome extension",
      url: "https://www.google.com/search?q=mechanical+keyboards"
    });
    expect(d.scan).toBe(false);
    expect(d.reason).toContain("search");
  });

  it("skips explicit web-search framing", () => {
    expect(shouldScanCurrentPage({ userMessage: "search the web for the best keyboards", url: "https://x.test" }).scan).toBe(false);
    expect(shouldScanCurrentPage({ userMessage: "google the latest react version", url: "https://x.test" }).scan).toBe(false);
    expect(shouldScanCurrentPage({ userMessage: "look up who won the 2026 super bowl", url: "https://x.test" }).scan).toBe(false);
  });

  it("skips a prompt that isn't about the current page", () => {
    expect(shouldScanCurrentPage({ userMessage: "write me a haiku about autumn", url: "https://x.test" }).scan).toBe(false);
  });

  it("does not treat web-framed 'this' as a current-page prompt", () => {
    expect(shouldScanCurrentPage({ userMessage: "search the web for this topic", url: "https://x.test" }).scan).toBe(false);
  });
});
