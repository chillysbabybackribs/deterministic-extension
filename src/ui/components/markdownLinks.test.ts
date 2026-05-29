import { describe, expect, it } from "vitest";
import { childrenIsBareUrl, prettyUrlLabel } from "./MarkdownMessage";

describe("prettyUrlLabel", () => {
  it("drops the scheme, www, and a bare trailing slash", () => {
    expect(prettyUrlLabel("https://playwright.dev/")).toBe("playwright.dev");
    expect(prettyUrlLabel("https://www.example.com/")).toBe("example.com");
    expect(prettyUrlLabel("http://example.com")).toBe("example.com");
  });

  it("keeps an informative path and query", () => {
    expect(prettyUrlLabel("https://playwright.dev/docs/intro")).toBe("playwright.dev/docs/intro");
    expect(prettyUrlLabel("https://example.com/search?q=test")).toBe("example.com/search?q=test");
  });

  it("shows just the address for mailto:", () => {
    expect(prettyUrlLabel("mailto:hi@example.com")).toBe("hi@example.com");
  });

  it("degrades gracefully on an unparseable string", () => {
    expect(prettyUrlLabel("not a url")).toBe("not a url");
  });
});

describe("childrenIsBareUrl", () => {
  it("detects link text that is just the URL (exact or scheme/slash-insensitive)", () => {
    expect(childrenIsBareUrl("https://playwright.dev/", "https://playwright.dev/")).toBe(true);
    expect(childrenIsBareUrl("playwright.dev", "https://playwright.dev/")).toBe(true);
    expect(childrenIsBareUrl(["https://playwright.dev/"], "https://playwright.dev/")).toBe(true);
  });

  it("leaves descriptive link text alone", () => {
    expect(childrenIsBareUrl("Playwright documentation", "https://playwright.dev/")).toBe(false);
    expect(childrenIsBareUrl("", "https://playwright.dev/")).toBe(false);
  });
});
