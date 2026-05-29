import { delay } from "../shared/asyncUtils";

export async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const current = await chrome.tabs.get(tabId).catch(() => undefined);
  if (current?.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = globalThis.setTimeout(cleanup, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeoutId);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}
