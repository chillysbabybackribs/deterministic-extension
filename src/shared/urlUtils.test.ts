import { describe, expect, it } from "vitest";
import { normalizeHttpUrl } from "./urlUtils";

describe("normalizeHttpUrl", () => {
  it("allows HTTPS URLs unchanged", () => {
    expect(normalizeHttpUrl("https://example.com/docs")).toBe("https://example.com/docs");
  });

  it.each([
    ["http://localhost:5173", "http://localhost:5173/"],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173/"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/"],
    ["http://[::1]:5173", "http://[::1]:5173/"]
  ])("allows localhost HTTP URL %s", (input, expected) => {
    expect(normalizeHttpUrl(input)).toBe(expected);
  });

  it.each([
    "http://example.com",
    "http://192.168.1.10:3000",
    "ftp://localhost",
    "file:///tmp/test.html",
    "javascript:alert(1)",
    "data:text/plain,hello"
  ])("blocks unsafe non-HTTPS URL %s", (input) => {
    expect(() => normalizeHttpUrl(input)).toThrow();
  });
});
