import { describe, expect, it } from "vitest";
import { candidatesFromLinks } from "./searchCandidates";

describe("candidatesFromLinks", () => {
  it("drops Google product/utility hosts that aren't organic results", () => {
    const candidates = candidatesFromLinks(
      [
        { text: "labs", url: "https://labs.google/" },
        { text: "Maps", url: "https://maps.google.com/maps?q=paris" },
        { text: "Real result", url: "https://koenvangilst.nl/lab/mistral-ai-now-summit" },
        { text: "Support", url: "https://support.google.com/websearch?p=foo" }
      ],
      10
    );
    const urls = candidates.map((c) => c.url);
    expect(urls).toEqual(["https://koenvangilst.nl/lab/mistral-ai-now-summit"]);
  });

  it("resolves google /url redirects to the real target", () => {
    const candidates = candidatesFromLinks(
      [{ text: "Article", url: "/url?q=https://example.com/post&sa=U" }],
      10
    );
    expect(candidates[0]?.url).toBe("https://example.com/post");
  });

  it("dedupes by normalized url and respects maxResults", () => {
    const candidates = candidatesFromLinks(
      [
        { text: "A", url: "https://example.com/a" },
        { text: "A dup", url: "https://example.com/a#frag" },
        { text: "B", url: "https://example.com/b" },
        { text: "C", url: "https://example.com/c" }
      ],
      2
    );
    expect(candidates.map((c) => c.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("keeps a legitimate non-google result through", () => {
    const candidates = candidatesFromLinks([{ text: "X post", url: "https://x.com/vnglst/status/123" }], 10);
    expect(candidates[0]?.url).toBe("https://x.com/vnglst/status/123");
  });
});
