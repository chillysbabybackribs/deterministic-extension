export const SIDE_PANEL_PATH = "src/app/index.html";

export function getSidePanelRedirectUrl(): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(SIDE_PANEL_PATH);
  }

  return "/";
}

export function getExtensionOrigin(): string | undefined {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL("").replace(/\/$/, "");
  }

  return undefined;
}
