import { describe, expect, it } from "vitest";
import { parseFollowup } from "./followup";

describe("parseFollowup", () => {
  it("parses a suggestion", () => {
    const r = parseFollowup('{"kind":"suggestion","text":"I could map the Copilot token flow next — want me to?"}');
    expect(r.kind).toBe("suggestion");
    expect(r.text).toContain("Copilot token flow");
  });

  it("parses a proceed directive", () => {
    const r = parseFollowup('{"kind":"proceed","text":"Capture this page\'s network traffic and summarize the API endpoints."}');
    expect(r.kind).toBe("proceed");
    expect(r.text).toContain("Capture this page");
  });

  it("collapses a proceed with empty text to none", () => {
    expect(parseFollowup('{"kind":"proceed","text":""}').kind).toBe("none");
  });

  it("parses a probe", () => {
    const r = parseFollowup('{"kind":"probe","text":"Are you reverse-engineering the API or debugging a specific call?"}');
    expect(r.kind).toBe("probe");
    expect(r.text).toContain("reverse-engineering");
  });

  it("returns none for kind none and ignores any text", () => {
    const r = parseFollowup('{"kind":"none","text":"ignored"}');
    expect(r.kind).toBe("none");
    expect(r.text).toBe("");
  });

  it("collapses a non-none kind with empty text to none", () => {
    const r = parseFollowup('{"kind":"suggestion","text":"   "}');
    expect(r.kind).toBe("none");
    expect(r.text).toBe("");
  });

  it("falls back to none on unparseable output", () => {
    expect(parseFollowup("not json at all").kind).toBe("none");
    expect(parseFollowup("").kind).toBe("none");
  });

  it("extracts JSON embedded in prose", () => {
    const r = parseFollowup('Here is my decision: {"kind":"probe","text":"What are you trying to build?"} done.');
    expect(r.kind).toBe("probe");
    expect(r.text).toBe("What are you trying to build?");
  });

  it("treats an unknown kind as none", () => {
    expect(parseFollowup('{"kind":"banter","text":"hi"}').kind).toBe("none");
  });
});
