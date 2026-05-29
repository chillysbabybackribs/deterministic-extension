import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActionableOverlayForPageChange,
  forgetActionableOverlayTab,
  hideAllActionableOverlays,
  isActionableOverlayTracked,
  scheduleActionableOverlayRepaint,
  showActionableOverlay,
  type OverlayCaptureResult
} from "./elementOverlay";

const TAB_ID = 10;

const capture: OverlayCaptureResult = {
  url: "https://example.com/",
  title: "Example",
  viewport: {
    width: 1200,
    height: 800,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    documentWidth: 1200,
    documentHeight: 1600
  },
  elements: [],
  candidateCount: 0,
  droppedByDedup: 0,
  warnings: []
};

function stubChrome() {
  const tab = {
    id: TAB_ID,
    windowId: 1,
    active: true,
    status: "complete",
    title: "Example",
    url: "https://example.com/"
  } as chrome.tabs.Tab;
  const executeScript = vi.fn(async () => [{ result: capture }]);
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      tabs: {
        get: vi.fn(async () => tab),
        query: vi.fn(async () => [tab])
      },
      scripting: {
        executeScript
      }
    }
  });
  return { executeScript };
}

describe("actionable overlay lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forgetActionableOverlayTab(TAB_ID);
  });

  afterEach(() => {
    forgetActionableOverlayTab(TAB_ID);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears a tracked overlay on page change without untracking the tab, then repaints", async () => {
    const { executeScript } = stubChrome();

    await showActionableOverlay(TAB_ID);
    expect(isActionableOverlayTracked(TAB_ID)).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(1);

    await expect(clearActionableOverlayForPageChange(TAB_ID)).resolves.toBe(true);
    expect(isActionableOverlayTracked(TAB_ID)).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(2);

    expect(scheduleActionableOverlayRepaint(TAB_ID, 25)).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(isActionableOverlayTracked(TAB_ID)).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(3);
  });

  it("turn-end cleanup clears tracked overlays and cancels pending repaints", async () => {
    const { executeScript } = stubChrome();

    await showActionableOverlay(TAB_ID);
    expect(scheduleActionableOverlayRepaint(TAB_ID, 1000)).toBe(true);

    await hideAllActionableOverlays();
    expect(isActionableOverlayTracked(TAB_ID)).toBe(false);
    expect(executeScript).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });
});
