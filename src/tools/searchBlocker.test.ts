import { describe, expect, it } from "vitest";
import { detectSearchResultBlocker } from "./searchBlocker";

describe("search blocker detection", () => {
  it("detects anti-automation search result pages", () => {
    expect(detectSearchResultBlocker({
      url: "https://www.google.com/sorry/index?continue=https://www.google.com/search?q=docs",
      title: "Sorry",
      text: "Our systems have detected unusual traffic from your computer network."
    })).toBe("Search page returned an anti-automation/non-result page instead of organic results.");
  });

  it("detects consent search result pages", () => {
    expect(detectSearchResultBlocker({
      url: "https://consent.google.com/",
      title: "Before you continue",
      text: "We use cookies and data."
    })).toBe("Search page returned a consent page instead of organic results.");
  });

  it("does not flag ordinary result pages", () => {
    expect(detectSearchResultBlocker({
      url: "https://www.google.com/search?q=chrome+extension+side+panel",
      title: "chrome extension side panel - Google Search",
      text: "Chrome for Developers chrome.sidePanel API documentation"
    })).toBeUndefined();
  });
});
