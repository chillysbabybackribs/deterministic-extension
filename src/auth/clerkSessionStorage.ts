import type { StorageCache } from "@clerk/chrome-extension";

const CLERK_SESSION_STORAGE_PREFIX = "browser-chat-assistant|clerk";
const memoryFallback = new Map<string, unknown>();

export const persistentClerkSessionCache: StorageCache = {
  createKey: (...keys: string[]) => [CLERK_SESSION_STORAGE_PREFIX, ...keys.filter(Boolean)].join("|"),

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const storage = getChromeLocalStorage();
    if (!storage) {
      return memoryFallback.get(key) as T | undefined;
    }

    return readChromeStorageValue<T>(storage, key);
  },

  async set(key: string, value: string): Promise<void> {
    const storage = getChromeLocalStorage();
    if (!storage) {
      memoryFallback.set(key, value);
      return;
    }

    await setChromeStorageValue(storage, key, value);
  },

  async remove(key: string): Promise<void> {
    const storage = getChromeLocalStorage();
    if (!storage) {
      memoryFallback.delete(key);
      return;
    }

    await removeChromeStorageValue(storage, key);
  }
};

type ChromeStorageArea = chrome.storage.StorageArea;

function getChromeLocalStorage(): ChromeStorageArea | undefined {
  return typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
}

function readChromeStorageValue<T>(storage: ChromeStorageArea, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    storage.get(key, (stored) => {
      const error = chrome.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(stored[key] as T | undefined);
    });
  });
}

function setChromeStorageValue(storage: ChromeStorageArea, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.set({ [key]: value }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function removeChromeStorageValue(storage: ChromeStorageArea, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.remove(key, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}
