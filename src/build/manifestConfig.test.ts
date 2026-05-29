import { describe, expect, it } from "vitest";
import { applyClerkManifestEnv, toHostPermission } from "./manifestConfig";

describe("toHostPermission", () => {
  it("returns undefined when the Clerk frontend API is missing", () => {
    expect(toHostPermission()).toBeUndefined();
    expect(toHostPermission("   ")).toBeUndefined();
  });

  it("normalizes a bare host into an https host permission", () => {
    expect(toHostPermission("clerk.example.dev")).toBe("https://clerk.example.dev/*");
  });

  it("preserves the origin for a full URL", () => {
    expect(toHostPermission("https://clerk.example.dev/v1")).toBe("https://clerk.example.dev/*");
  });
});

describe("applyClerkManifestEnv", () => {
  it("adds the CRX public key and Clerk host permission", () => {
    expect(
      applyClerkManifestEnv(
        {
          host_permissions: ["https://api.anthropic.com/*"]
        },
        {
          clerkFrontendApi: "clerk.example.dev",
          crxPublicKey: "test-public-key"
        }
      )
    ).toEqual({
      key: "test-public-key",
      host_permissions: ["https://api.anthropic.com/*", "https://clerk.example.dev/*"]
    });
  });

  it("does not duplicate an existing Clerk host permission", () => {
    expect(
      applyClerkManifestEnv(
        {
          host_permissions: ["https://clerk.example.dev/*"]
        },
        {
          clerkFrontendApi: "https://clerk.example.dev",
          crxPublicKey: ""
        }
      )
    ).toEqual({
      host_permissions: ["https://clerk.example.dev/*"]
    });
  });
});
