import { describe, expect, it } from "vitest";
import { parseRouteDecision } from "./router";

describe("parseRouteDecision", () => {
  it("recognizes a clean chat verdict", () => {
    expect(parseRouteDecision("chat")).toBe("chat");
    expect(parseRouteDecision("CHAT")).toBe("chat");
    expect(parseRouteDecision("  chat\n")).toBe("chat");
  });

  it("recognizes chat with stray quoting/punctuation", () => {
    expect(parseRouteDecision('"chat"')).toBe("chat");
    expect(parseRouteDecision("chat.")).toBe("chat");
  });

  it("treats tools as tools", () => {
    expect(parseRouteDecision("tools")).toBe("tools");
    expect(parseRouteDecision("TOOLS")).toBe("tools");
  });

  it("defaults to tools for anything unclear or empty", () => {
    expect(parseRouteDecision("")).toBe("tools");
    expect(parseRouteDecision("I think this needs tools because...")).toBe("tools");
    expect(parseRouteDecision("maybe chat?")).toBe("tools"); // not a clean chat verdict
    expect(parseRouteDecision("unknown")).toBe("tools");
  });
});
