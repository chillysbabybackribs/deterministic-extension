import { afterEach, describe, expect, it, vi } from "vitest";
import { getExtensionOrigin, getSidePanelRedirectUrl, SIDE_PANEL_PATH } from "./extensionUrl";

describe("getSidePanelRedirectUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back outside an extension runtime", () => {
    vi.stubGlobal("chrome", undefined);

    expect(getSidePanelRedirectUrl()).toBe("/");
  });

  it("uses the side panel entrypoint inside an extension runtime", () => {
    const getURL = vi.fn((path: string) => `chrome-extension://extension-id/${path}`);
    vi.stubGlobal("chrome", { runtime: { getURL } });

    expect(getSidePanelRedirectUrl()).toBe("chrome-extension://extension-id/src/app/index.html");
    expect(getURL).toHaveBeenCalledWith(SIDE_PANEL_PATH);
  });

  it("returns the extension origin inside an extension runtime", () => {
    const getURL = vi.fn((path: string) => `chrome-extension://extension-id/${path}`);
    vi.stubGlobal("chrome", { runtime: { getURL } });

    expect(getExtensionOrigin()).toBe("chrome-extension://extension-id");
  });
});
