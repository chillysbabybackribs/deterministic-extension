import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS, loadSettings, saveSettings } from "./settingsStore";

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");

describe("settings store", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: undefined
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    });
  });

  afterEach(() => {
    restoreGlobal("localStorage", originalLocalStorageDescriptor);
    restoreGlobal("chrome", originalChromeDescriptor);
  });

  it("preserves disabled page actions when loading settings", async () => {
    storage.set("ohmygod.settings", JSON.stringify({
      dev: {
        permissiveExecution: false
      }
    }));

    const settings = await loadSettings();

    expect(settings.dev.permissiveExecution).toBe(false);
  });

  it("does not force disabled page actions back on when saving settings", async () => {
    await saveSettings({
      ...DEFAULT_APP_SETTINGS,
      dev: {
        ...DEFAULT_APP_SETTINGS.dev,
        permissiveExecution: false
      }
    });

    const saved = JSON.parse(storage.get("ohmygod.settings") ?? "{}");
    expect(saved.dev.permissiveExecution).toBe(false);
  });
});

function restoreGlobal(
  key: "chrome" | "localStorage",
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }

  Reflect.deleteProperty(globalThis, key);
}
