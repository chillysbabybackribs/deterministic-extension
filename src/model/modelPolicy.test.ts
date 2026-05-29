import { describe, expect, it } from "vitest";
import { classifyComplexity, selectModel } from "./modelPolicy";
import {
  CLAUDE_HAIKU_4_5_MODEL,
  CLAUDE_SONNET_4_6_MODEL,
  type ModelSettings
} from "../settings/modelSettings";

const settings: ModelSettings = {
  model: CLAUDE_HAIKU_4_5_MODEL,
  researchSynthesisModel: "auto",
  temperature: 0.2,
  maxOutputTokens: 1600
};

describe("classifyComplexity", () => {
  it("short, plain prompts are simple", () => {
    expect(classifyComplexity("open the cart")).toBe("simple");
    expect(classifyComplexity("hi")).toBe("simple");
  });

  it("reasoning words push to standard", () => {
    expect(classifyComplexity("explain how this works")).toBe("standard");
  });

  it("a multi-entity comparison in one long sentence is complex (no '.' breaks)", () => {
    const prompt =
      "research how Playwright, Puppeteer, and Selenium differ for browser automation in 2026 — " +
      "compare their architecture, language support, and handling of modern SPAs, and tell me which " +
      "is best for a Chrome extension that drives the page deterministically";
    expect(classifyComplexity(prompt)).toBe("complex");
  });

  it("a plain three-item list without reasoning is not forced complex", () => {
    expect(classifyComplexity("add milk, eggs, and bread to the list")).toBe("standard");
  });

  it("long, multi-part, reasoning prompts are complex", () => {
    const prompt =
      "First, analyze the architecture of this codebase and explain the trade-offs. " +
      "Then compare it to the alternative design and derive why one is faster. " +
      "After that, summarize the key risks in detail with concrete examples and reasoning.";
    expect(classifyComplexity(prompt)).toBe("complex");
  });
});

describe("selectModel", () => {
  it("mechanical steps use the fast tier (the chat model)", () => {
    expect(selectModel({ step: "router", complexity: "simple", settings }).model).toBe(CLAUDE_HAIKU_4_5_MODEL);
    expect(selectModel({ step: "gate", complexity: "standard", settings }).model).toBe(CLAUDE_HAIKU_4_5_MODEL);
    expect(selectModel({ step: "followup", complexity: "standard", settings }).model).toBe(CLAUDE_HAIKU_4_5_MODEL);
  });

  it("synthesis uses the strong tier (Sonnet when researchSynthesis is auto)", () => {
    expect(selectModel({ step: "synthesis", complexity: "simple", settings }).model).toBe(CLAUDE_SONNET_4_6_MODEL);
  });

  it("a complex task bumps mechanical steps up to the strong tier", () => {
    expect(selectModel({ step: "gate", complexity: "complex", settings }).model).toBe(CLAUDE_SONNET_4_6_MODEL);
    expect(selectModel({ step: "planner", complexity: "complex", settings }).model).toBe(CLAUDE_SONNET_4_6_MODEL);
  });

  it("respects an explicit researchSynthesis pick for the strong tier", () => {
    const explicit: ModelSettings = { ...settings, researchSynthesisModel: CLAUDE_HAIKU_4_5_MODEL };
    expect(selectModel({ step: "synthesis", complexity: "simple", settings: explicit }).model).toBe(CLAUDE_HAIKU_4_5_MODEL);
  });

  it("tags the provider for provider-agnostic call sites", () => {
    expect(selectModel({ step: "router", complexity: "simple", settings }).provider).toBe("anthropic");
  });
});
