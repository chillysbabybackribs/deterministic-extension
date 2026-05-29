import { describe, expect, it } from "vitest";
import { STOPWORDS, termMatch, tokenize } from "./textUtils";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric, and drops short tokens", () => {
    expect(tokenize("Hello, WORLD! a3 x")).toEqual(["hello", "world", "a3"]);
  });

  it("drops stopwords", () => {
    expect(tokenize("the quick brown fox and the lazy dog")).toEqual([
      "quick",
      "brown",
      "fox",
      "lazy",
      "dog"
    ]);
  });

  it("keeps multi-char alphanumeric tokens and drops single chars", () => {
    // single digits "4"/"8" are length-1 and dropped; "v48" survives.
    expect(tokenize("claude opus 4.8 v48 model")).toEqual(["claude", "opus", "v48", "model"]);
  });

  it("returns an empty array for stopword-only or empty input", () => {
    expect(tokenize("the and of to")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("has a small explicit stopword set", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("pricing")).toBe(false);
  });
});

describe("termMatch", () => {
  it("matches single words on word boundaries (no partial-word hits)", () => {
    expect(termMatch("the cat sat", "cat")).toBe(true);
    expect(termMatch("category theory", "cat")).toBe(false);
  });

  it("matches multi-word phrases by substring", () => {
    expect(termMatch("the enterprise plan costs more", "enterprise plan")).toBe(true);
    expect(termMatch("enterprise pricing", "enterprise plan")).toBe(false);
  });

  it("matches at string boundaries", () => {
    expect(termMatch("cat", "cat")).toBe(true);
    expect(termMatch("a cat", "cat")).toBe(true);
  });
});
