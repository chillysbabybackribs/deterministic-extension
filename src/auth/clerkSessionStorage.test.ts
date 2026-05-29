import { afterEach, describe, expect, it, vi } from "vitest";
import { persistentClerkSessionCache } from "./clerkSessionStorage";

describe("persistentClerkSessionCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("namespaces Clerk session cache keys", () => {
    expect(persistentClerkSessionCache.createKey("jwt", "pk_test")).toBe(
      "browser-chat-assistant|clerk|jwt|pk_test"
    );
  });

  it("persists session cache values in chrome.storage.local", async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key: string, callback: (value: Record<string, unknown>) => void) => {
            callback({ [key]: stored[key] });
          }),
          set: vi.fn((value: Record<string, unknown>, callback: () => void) => {
            Object.assign(stored, value);
            callback();
          }),
          remove: vi.fn((key: string, callback: () => void) => {
            delete stored[key];
            callback();
          })
        }
      }
    });

    const key = persistentClerkSessionCache.createKey("session", "frontend");
    await persistentClerkSessionCache.set(key, "jwt-value");

    await expect(persistentClerkSessionCache.get(key)).resolves.toBe("jwt-value");

    await persistentClerkSessionCache.remove(key);

    await expect(persistentClerkSessionCache.get(key)).resolves.toBeUndefined();
  });
});
