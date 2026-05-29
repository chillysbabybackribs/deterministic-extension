import { describe, expect, it } from "vitest";
import { buildEngineCorpus, searchEngineCorpus, renderEngineGrounding } from "./engineKnowledgeCorpus";

describe("engine knowledge corpus", () => {
  it("always grounds on the core entries (what it is + how capture works)", () => {
    const r = searchEngineCorpus("anything at all");
    const ids = r.entries.map((e) => e.id);
    expect(ids).toContain("what-is-the-engine");
    expect(ids).toContain("how-inbrowser-capture-works");
  });

  it("surfaces backend-mapping entry for a backend prompt", () => {
    const r = searchEngineCorpus("go deep into the backend of this web app");
    const ids = r.entries.map((e) => e.id);
    expect(ids).toContain("task-backend-mapping");
  });

  it("surfaces the logged-in-session entry for an auth/login prompt", () => {
    const r = searchEngineCorpus("can it capture data behind my login / authenticated session?");
    const ids = r.entries.map((e) => e.id);
    expect(ids).toContain("logged-in-session");
  });

  it("respects the limit", () => {
    const r = searchEngineCorpus("backend api login network response bodies security", buildEngineCorpus(), 3);
    expect(r.entries.length).toBeLessThanOrEqual(3);
  });

  it("renders grounding that carries the corrected capture fact (MV3, not just CSP)", () => {
    const text = renderEngineGrounding(searchEngineCorpus("why couldn't you read the response bodies"));
    expect(text).toContain("Manifest V3");
    expect(text).toContain("response BODIES");
    // The corrected fact: webRequest can't read response bodies (not "can't see requests").
    expect(text.toLowerCase()).toContain("webrequest");
  });

  it("returns entries (never empty) so an answer is always grounded", () => {
    expect(searchEngineCorpus("").entries.length).toBeGreaterThan(0);
  });
});
