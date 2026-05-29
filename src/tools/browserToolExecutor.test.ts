import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeBrowserToolLocally } from "./browserToolExecutor";
import { readWorkspaceImageFile } from "../filesystem/workspaceStore";
import { snapshotTab } from "./pageSnapshot";
import { observeTab, performPageAction } from "./pageInteraction";

vi.mock("../filesystem/workspaceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../filesystem/workspaceStore")>();
  return {
    ...actual,
    readWorkspaceImageFile: vi.fn()
  };
});

vi.mock("./chromeTabs", () => ({
  waitForTabComplete: vi.fn(async () => undefined)
}));

vi.mock("./pageSnapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pageSnapshot")>();
  return {
    ...actual,
    snapshotTab: vi.fn()
  };
});

vi.mock("./pageInteraction", () => ({
  checkPageCondition: vi.fn(),
  hasPageActionTarget: vi.fn(() => true),
  hasPageCondition: vi.fn(),
  normalizePageActionTarget: vi.fn(() => ({ selector: "#save" })),
  normalizePageCondition: vi.fn(),
  observeTab: vi.fn(),
  performPageAction: vi.fn()
}));

const activeTab = {
  id: 10,
  windowId: 1,
  active: true,
  status: "complete",
  title: "Fixture",
  url: "https://example.com/"
};

describe("browser tool executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path}`)
        },
        search: {
          query: vi.fn(async () => undefined)
        },
        tabGroups: {
          update: vi.fn(async (groupId: number, updateProperties: chrome.tabGroups.UpdateProperties) => ({
            id: groupId,
            windowId: 1,
            collapsed: false,
            color: updateProperties.color ?? "grey",
            title: updateProperties.title ?? ""
          }))
        },
        tabs: {
          query: vi.fn(async () => [activeTab]),
          get: vi.fn(async () => activeTab),
          create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => ({
            ...activeTab,
            id: 11,
            url: createProperties.url,
            title: "Google Images",
            active: createProperties.active ?? true
          })),
          group: vi.fn(async () => 20)
        },
        scripting: {
          executeScript: vi.fn(async () => [{
            result: {
              url: "https://www.google.com/search?q=avedon&tbm=isch",
              title: "avedon - Google Search",
              imageCount: 24,
              images: Array.from({ length: 24 }, (_, index) => ({
                index: index + 1,
                title: `Image result ${index + 1}`,
                source: "example.com",
                pageUrl: `https://example.com/image-${index + 1}`,
                thumbnailUrl: `https://encrypted-tbn0.gstatic.com/image-${index + 1}`
              }))
            }
          }])
        }
      }
    });

    vi.mocked(snapshotTab).mockResolvedValue({
      url: "https://example.com/",
      title: "Example Domain",
      description: "Fixture page",
      headings: ["Example Domain"],
      text: "Example Domain\n\nThis domain is for use in illustrative examples.",
      fullText: "Example Domain\n\nThis domain is for use in illustrative examples.",
      links: []
    });
    vi.mocked(performPageAction).mockResolvedValue({
      action: "click",
      ok: true,
      message: "Clicked Save.",
      target: {
        ref: "el_1",
        selector: "#save",
        tagName: "button",
        name: "Save",
        disabled: false,
        editable: false,
        visible: true
      },
      title: "Fixture",
      url: "https://example.com/",
      warnings: []
    });
    vi.mocked(observeTab).mockResolvedValue({
      url: "https://example.com/",
      title: "Fixture",
      readyState: "complete",
      viewport: {
        width: 1024,
        height: 768
      },
      scroll: {
        x: 0,
        y: 0,
        maxY: 0
      },
      textSample: "Save",
      elements: [],
      frameCount: 1,
      warnings: []
    });
  });

  it("treats blocked direct web search pages as failed tool results", async () => {
    const existingTab = { ...activeTab, id: 1, active: false };
    const blockedTab = {
      ...activeTab,
      id: 2,
      active: true,
      title: "Sorry",
      url: "https://www.google.com/sorry/index?continue=https://www.google.com/search?q=docs"
    };
    const queryTabs = vi.mocked(chrome.tabs.query as unknown as (queryInfo?: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>);
    queryTabs
      .mockResolvedValueOnce([existingTab as chrome.tabs.Tab])
      .mockResolvedValueOnce([existingTab as chrome.tabs.Tab, blockedTab as chrome.tabs.Tab]);
    vi.mocked(snapshotTab).mockResolvedValue({
      url: blockedTab.url,
      title: "Sorry",
      headings: [],
      text: "Our systems have detected unusual traffic from your computer network. This page is not an organic result page and may require a CAPTCHA.",
      fullText: "Our systems have detected unusual traffic from your computer network. This page is not an organic result page and may require a CAPTCHA.",
      links: []
    });

    const execution = await executeBrowserToolLocally({
      id: "search_1",
      name: "web_search",
      input: {
        query: "official docs"
      }
    });

    expect(execution.status).toBe("failed");
    expect(execution.summary).toContain("anti-automation");
    expect(execution.failures).toHaveLength(1);
    expect(execution.evidenceItems[0]?.type).toBe("tool_failure");
    expect(execution.extractedTextSample).toBe("");
  });

  it("opens Google Images and extracts many image results for visual search", async () => {
    const execution = await executeBrowserToolLocally({
      id: "image_search_1",
      name: "web_search",
      input: {
        query: "Richard Avedon most famous photographs",
        searchType: "images",
        minImages: 24
      }
    });

    expect(chrome.search.query).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("tbm=isch"),
      active: true
    });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringContaining("udm=2"),
      active: true
    });
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(execution.status).toBe("success");
    expect(execution.summary).toContain("24 visible image result");
    expect(execution.output).toMatchObject({
      query: "Richard Avedon most famous photographs",
      searchType: "images",
      provider: "google_images",
      minImages: 24
    });
  });

  it("inspects current page app structure, controls, storage, and resource timing", async () => {
    vi.mocked(chrome.scripting.executeScript as unknown as (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => Promise<Array<{ result: unknown }>>)
      .mockResolvedValueOnce([{
        result: {
          url: "https://app.example.com/dashboard",
          title: "Example App",
          readyState: "complete",
          viewport: {
            width: 1024,
            height: 768,
            devicePixelRatio: 1
          },
          scroll: {
            x: 0,
            y: 0,
            maxY: 1200
          },
          location: {
            origin: "https://app.example.com",
            pathname: "/dashboard",
            search: "",
            hash: ""
          },
          document: {
            charset: "UTF-8",
            visibilityState: "visible"
          },
          frameworkHints: ["Next.js", "React devtools hook present"],
          domSummary: {
            totalElements: 42,
            byTag: {
              div: 20,
              button: 2,
              form: 1
            },
            headings: [{ level: 1, text: "Dashboard" }],
            landmarks: [{ tagName: "main", role: "main", text: "Dashboard" }],
            forms: [{
              index: 0,
              method: "POST",
              fieldCount: 1,
              submitTexts: ["Save"],
              fields: [{
                tagName: "input",
                name: "email",
                label: "Email",
                required: true,
                disabled: false
              }]
            }],
            interactiveElements: [{
              tagName: "button",
              role: "button",
              name: "Save",
              text: "Save",
              disabled: false,
              visible: true
            }]
          },
          domTree: {
            tagName: "body",
            visible: true,
            childElementCount: 1,
            children: [{
              tagName: "main",
              role: "main",
              visible: true,
              childElementCount: 1
            }]
          },
          network: {
            navigation: {
              type: "navigate",
              durationMs: 400
            },
            resourceCountsByType: {
              fetch: 1,
              script: 2
            },
            resourceOrigins: [{ origin: "https://app.example.com", count: 3 }],
            resources: [{
              url: "https://app.example.com/api/user",
              origin: "https://app.example.com",
              path: "/api/user",
              initiatorType: "fetch",
              durationMs: 25
            }],
            apiLikeResources: [{
              url: "https://app.example.com/api/user",
              initiatorType: "fetch",
              durationMs: 25
            }]
          },
          scripts: {
            external: [{ src: "https://app.example.com/_next/static/app.js", async: false, defer: true }],
            inlineCount: 1,
            moduleCount: 1
          },
          styles: {
            external: [{ href: "https://app.example.com/app.css" }],
            inlineCount: 1
          },
          storage: {
            localStorage: [{ key: "auth.session", valueLength: 120 }],
            sessionStorage: [],
            cookies: {
              count: 1,
              names: ["theme"],
              valuesIncluded: false
            },
            warnings: []
          },
          warnings: []
        }
      }]);

    const execution = await executeBrowserToolLocally({
      id: "inspect_1",
      name: "browser_inspect_page_app",
      input: {
        includeDomTree: true,
        includeNetwork: true
      }
    });

    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(execution.status).toBe("success");
    expect(execution.summary).toContain("42 DOM element");
    expect(execution.output).toMatchObject({
      inspection: {
        frameworkHints: ["Next.js", "React devtools hook present"],
        network: {
          apiLikeResources: [{ url: "https://app.example.com/api/user" }]
        }
      }
    });
    expect(execution.extractedTextSample).toContain("API-like resources");
    expect(execution.extractedTextSample).toContain("auth.session");
  });

  it("runs mandatory page exploration with before and after inspection evidence", async () => {
    const inspection = {
      url: "https://app.example.com/dashboard",
      title: "Example App",
      readyState: "complete",
      viewport: { width: 1024, height: 768, devicePixelRatio: 1 },
      scroll: { x: 0, y: 0, maxY: 1200 },
      location: { origin: "https://app.example.com", pathname: "/dashboard", search: "", hash: "" },
      document: { charset: "UTF-8", visibilityState: "visible" },
      frameworkHints: ["Next.js"],
      domSummary: {
        totalElements: 42,
        byTag: { div: 20, button: 2 },
        headings: [{ level: 1, text: "Dashboard" }],
        landmarks: [],
        forms: [],
        interactiveElements: [{
          tagName: "button",
          role: "button",
          name: "Menu",
          text: "Menu",
          disabled: false,
          visible: true
        }]
      },
      network: {
        resourceCountsByType: { fetch: 1 },
        resourceOrigins: [{ origin: "https://app.example.com", count: 1 }],
        resources: [{ url: "https://app.example.com/api/user", initiatorType: "fetch" }],
        apiLikeResources: [{ url: "https://app.example.com/api/user", initiatorType: "fetch" }]
      },
      scripts: { external: [], inlineCount: 0, moduleCount: 0 },
      styles: { external: [], inlineCount: 0 },
      storage: {
        localStorage: [{ key: "auth.session", valueLength: 12 }],
        sessionStorage: [],
        cookies: { count: 0, names: [], valuesIncluded: false },
        warnings: []
      },
      warnings: []
    };
    vi.mocked(chrome.scripting.executeScript as unknown as (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => Promise<Array<{ result: unknown }>>)
      .mockResolvedValueOnce([{ result: inspection }])
      .mockResolvedValueOnce([{
        result: {
          url: "https://app.example.com/dashboard",
          title: "Example App",
          events: [{
            kind: "safe_interaction",
            label: "Safely interacted with non-destructive control",
            target: { tagName: "button", role: "button", text: "Menu" },
            diff: {
              urlChanged: false,
              newHeadings: [],
              newControls: ["button: Settings"],
              newResourceCount: 1,
              newStorageKeys: { localStorage: [], sessionStorage: [] },
              visibleTextChanged: true
            }
          }],
          skippedRiskyTargets: [{ tagName: "button", role: "button", text: "Delete" }],
          warnings: []
        }
      }])
      .mockResolvedValueOnce([{ result: inspection }]);

    const execution = await executeBrowserToolLocally({
      id: "explore_1",
      name: "browser_explore_page",
      input: {}
    });

    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
    expect(observeTab).toHaveBeenCalledTimes(2);
    expect(execution.status).toBe("success");
    expect(execution.summary).toContain("1 safe interaction");
    expect(execution.summary).toContain("1 risky target");
    expect(execution.extractedTextSample).toContain("Mandatory page exploration pipeline ran");
    expect(execution.extractedTextSample).toContain("Risky targets skipped");
  });

  it("blocks mutating page actions when page actions are disabled", async () => {
    const execution = await executeBrowserToolLocally({
      id: "click_1",
      name: "browser_click",
      input: {
        target: { selector: "#save" }
      }
    }, {
      allowPageActions: false
    });

    expect(execution.status).toBe("failed");
    expect(execution.summary).toContain("Page actions are disabled");
    expect(performPageAction).not.toHaveBeenCalled();
  });

  it("allows mutating page actions when page actions are enabled", async () => {
    const execution = await executeBrowserToolLocally({
      id: "click_2",
      name: "browser_click",
      input: {
        target: { selector: "#save" }
      }
    }, {
      allowPageActions: true
    });

    expect(execution.status).toBe("success");
    expect(performPageAction).toHaveBeenCalledWith(10, "click", { selector: "#save" }, {});
  });

  it("opens workspace images in the extension image viewer", async () => {
    vi.mocked(readWorkspaceImageFile).mockResolvedValue({
      path: "assets/logo.png",
      name: "logo.png",
      size: 1200,
      lastModified: 1,
      type: "image/png",
      file: new File(["image"], "logo.png", { type: "image/png" })
    });

    const execution = await executeBrowserToolLocally({
      id: "open_image_1",
      name: "fs_open_image",
      input: {
        path: "assets/logo.png"
      }
    });

    expect(chrome.runtime.getURL).toHaveBeenCalledWith("src/image-viewer/index.html?path=assets%2Flogo.png");
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://extension-id/src/image-viewer/index.html?path=assets%2Flogo.png",
      active: true
    });
    expect(execution.status).toBe("success");
    expect(execution.summary).toBe("Opened assets/logo.png in the image viewer.");
    expect(execution.output).toMatchObject({
      viewerUrl: "chrome-extension://extension-id/src/image-viewer/index.html?path=assets%2Flogo.png"
    });
  });

  it("records timing diagnostics on tool, step, visible action, and activity envelopes", async () => {
    const execution = await executeBrowserToolLocally({
      id: "extract_1",
      name: "browser_extract_page",
      input: {
        maxChars: 4000
      }
    });

    expect(execution.status).toBe("success");
    expect(execution.activity.startedAt).toBeDefined();
    expect(execution.activity.endedAt).toBeDefined();
    expect(execution.activity.durationMs).toBeGreaterThanOrEqual(0);
    expect(execution.toolResult.durationMs).toBe(execution.activity.durationMs);
    expect(execution.stepResult.durationMs).toBe(execution.activity.durationMs);
    expect(execution.visibleActions[0]?.durationMs).toBe(execution.activity.durationMs);
  });

  it("creates titled Chrome tab groups from explicit tab IDs", async () => {
    const tabs = [
      activeTab,
      {
        id: 11,
        windowId: 1,
        active: false,
        status: "complete",
        title: "Claude Platform",
        url: "https://console.anthropic.com/"
      },
      {
        id: 12,
        windowId: 1,
        active: false,
        status: "complete",
        title: "Mail",
        url: "https://mail.example.com/"
      }
    ];
    vi.mocked(chrome.tabs.query as unknown as (queryInfo?: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>)
      .mockResolvedValueOnce(tabs as chrome.tabs.Tab[]);

    const execution = await executeBrowserToolLocally({
      id: "group_1",
      name: "browser_group_tabs",
      input: {
        groups: [
          {
            title: "AI",
            color: "blue",
            tabIds: [10, 11]
          }
        ]
      }
    });

    expect(execution.status).toBe("success");
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [10, 11] });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(20, { title: "AI", color: "blue" });
    expect(execution.groupedTabIds).toEqual([10, 11]);
    expect(execution.visibleActions[0]).toMatchObject({
      kind: "group_tabs",
      visible: true,
      status: "completed"
    });
    expect(execution.summary).toBe("1 tab group created for 2 tabs.");
  });

  it("returns a partial fallback snapshot when active tab snapshot and fetch fallback both fail", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(snapshotTab).mockRejectedValue(new Error("Page snapshot returned no content."));

    const execution = await executeBrowserToolLocally({
      id: "read_active_fallback",
      name: "browser_read_active_tab",
      input: {
        includeSnapshot: true
      }
    });

    expect(execution.status).toBe("partial");
    expect(fetchMock).toHaveBeenCalled();
    expect(execution.warnings?.some((warning) => warning.includes("snapshot"))).toBe(true);
    expect(execution.summary).toBe("Fixture");
    expect(execution.output).toMatchObject({
      snapshot: {
        text: "Page snapshot unavailable.",
        url: "https://example.com/"
      }
    });
    fetchMock.mockRestore();
  }, 15000);

  it("returns a partial fallback snapshot for non-https active tabs without attempting fetch", async () => {
    const nonHttpTab = {
      ...activeTab,
      id: 11,
      url: "chrome://newtab/"
    } as unknown as chrome.tabs.Tab;
    const queryTabs = vi.mocked(chrome.tabs.query as unknown as (queryInfo?: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>);
    queryTabs.mockResolvedValue([nonHttpTab as chrome.tabs.Tab]);
    const getTab = vi.mocked(chrome.tabs.get as unknown as (tabId: number) => Promise<chrome.tabs.Tab>);
    getTab.mockResolvedValue(nonHttpTab);
    vi.mocked(snapshotTab).mockRejectedValue(new Error("Page snapshot returned no content."));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const execution = await executeBrowserToolLocally({
      id: "read_active_non_http",
      name: "browser_read_active_tab",
      input: {
        includeSnapshot: true
      }
    });

    expect(execution.status).toBe("partial");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execution.output).toMatchObject({
      snapshot: {
        text: "Page snapshot unavailable.",
        url: "chrome://newtab/"
      }
    });
    fetchMock.mockRestore();
  }, 15000);
});
