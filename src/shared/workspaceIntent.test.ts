import { describe, expect, it } from "vitest";
import { hasLikelyWorkspaceWriteIntent } from "./workspaceIntent";

describe("hasLikelyWorkspaceWriteIntent", () => {
  it("detects broad local rebuild and implementation requests", () => {
    expect(hasLikelyWorkspaceWriteIntent("can you help me rebuild this")).toBe(true);
    expect(hasLikelyWorkspaceWriteIntent("deep dive this application and rebuild it in the connected folder")).toBe(true);
    expect(hasLikelyWorkspaceWriteIntent("create a React component in this folder")).toBe(true);
  });

  it("detects concrete generated file writes", () => {
    expect(hasLikelyWorkspaceWriteIntent("generate a README.md with hello")).toBe(true);
    expect(hasLikelyWorkspaceWriteIntent("save the answer to docs/report.md")).toBe(true);
  });

  it("does not treat ordinary prose edits as filesystem writes", () => {
    expect(hasLikelyWorkspaceWriteIntent("write this thank-you note")).toBe(false);
    expect(hasLikelyWorkspaceWriteIntent("make this paragraph friendlier")).toBe(false);
  });
});
