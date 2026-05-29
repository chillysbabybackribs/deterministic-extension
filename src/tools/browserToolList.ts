export type AnthropicToolSchema = {
  name: BrowserToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type BrowserToolName =
  | "browser_read_active_tab"
  | "browser_list_tabs"
  | "browser_open_tab"
  | "browser_group_tabs"
  | "browser_navigate_active_tab"
  | "browser_observe_page"
  | "browser_inspect_page_app"
  | "browser_explore_page"
  | "browser_click"
  | "browser_type"
  | "browser_select"
  | "browser_press_key"
  | "browser_scroll_page"
  | "browser_wait_for"
  | "browser_assert_page"
  | "web_search"
  | "browser_extract_page"
  | "browser_find_in_page"
  | "browser_capture_network"
  | "fs_get_workspace"
  | "fs_list_directory"
  | "fs_read_file"
  | "fs_open_image"
  | "fs_search_files"
  | "fs_write_file";

export const HAIKU_BROWSER_TOOLS: AnthropicToolSchema[] = [
  {
    name: "browser_read_active_tab",
    description: "Read active tab metadata or snapshot, optionally including structured page data.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeSnapshot: {
          type: "boolean"
        },
        maxChars: {
          type: "number"
        },
        includeLinks: {
          type: "boolean"
        },
        includeStructured: {
          type: "boolean",
          description: "Include selected text, article metadata, tables, code blocks, forms, and price-like values."
        }
      }
    }
  },
  {
    name: "browser_list_tabs",
    description: "List open tabs.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        currentWindowOnly: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_open_tab",
    description: "Open an HTTPS URL, or an HTTP localhost URL, in a tab.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string"
        },
        active: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_group_tabs",
    description: "Create Chrome tab groups from explicit tab IDs. Use browser_list_tabs first, then group related tabs by topic with short titles.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["groups"],
      properties: {
        currentWindowOnly: {
          type: "boolean",
          description: "When true, only tab IDs in the current window may be grouped. Defaults to true."
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "tabIds"],
            properties: {
              title: {
                type: "string",
                description: "Short visible Chrome tab group title."
              },
              color: {
                type: "string",
                enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]
              },
              tabIds: {
                type: "array",
                items: {
                  type: "number"
                },
                description: "Tab IDs returned by browser_list_tabs."
              }
            }
          }
        }
      }
    }
  },
  {
    name: "browser_navigate_active_tab",
    description: "Navigate, reload, back, or forward active tab.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["go_to", "reload", "back", "forward"]
        },
        url: {
          type: "string"
        },
        tabId: {
          type: "number",
          description: "Target a specific tab instead of the active one. go_to activates it."
        }
      }
    }
  },
  {
    name: "browser_observe_page",
    description: "Observe the active page or a tab as deterministic interactive elements with stable CSS refs, roles, names, labels, state, and bounds.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: {
          type: "number"
        },
        maxElements: {
          type: "number",
          description: "Optional maximum interactive elements to return. Omit for unbounded collection."
        },
        includeInvisible: {
          type: "boolean",
          description: "Include hidden or offscreen elements. Defaults to false."
        }
      }
    }
  },
  {
    name: "browser_inspect_page_app",
    description: "Inspect the active web app/page for real functionality evidence: DOM tree, semantic structure, interactive controls, forms, framework/build hints, storage keys, scripts/styles, and Performance Resource Timing network/resource entries. Use this first for current-page questions about how an app works, DOM/tree views, requests/API calls, page state, routes, or functionality.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: {
          type: "number"
        },
        includeDomTree: {
          type: "boolean",
          description: "Include a pruned DOM tree. Defaults to true."
        },
        includeNetwork: {
          type: "boolean",
          description: "Include Performance API navigation/resource timing entries. Defaults to true."
        },
        includeStorage: {
          type: "boolean",
          description: "Include localStorage/sessionStorage/cookie key names and IndexedDB database names. Defaults to true."
        },
        includeStorageValues: {
          type: "boolean",
          description: "Include short localStorage/sessionStorage value previews. Defaults to false; use only when the user asks for app state details."
        },
        includeScripts: {
          type: "boolean",
          description: "Include script source/build hints. Defaults to true."
        },
        includeStyles: {
          type: "boolean",
          description: "Include stylesheet source hints. Defaults to true."
        },
        maxDomNodes: {
          type: "number",
          description: "Optional maximum DOM/tree/control nodes to return. Omit for unbounded collection."
        },
        maxTreeDepth: {
          type: "number",
          description: "Optional maximum DOM tree depth. Omit for unbounded traversal."
        },
        maxResources: {
          type: "number",
          description: "Optional maximum resource timing entries to return. Omit for unbounded collection."
        },
        maxTextChars: {
          type: "number",
          description: "Optional maximum characters for text and URL snippets inside the inspection. Omit for unbounded text."
        }
      }
    }
  },
  {
    name: "browser_explore_page",
    description: "Run the mandatory deep page exploration pipeline for current-page technical inspection: inspect DOM/network/storage/scripts, observe interactive elements, scroll to reveal lazy content, safely interact with non-destructive controls such as menus/tabs/expanders/dropdowns, record skipped risky controls, then inspect again and return an evidence timeline. Risky actions such as submit, transfer, upload, pay, delete, sign, or file inputs are never performed by this tool.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: {
          type: "number"
        },
        includeStorageValues: {
          type: "boolean",
          description: "Include short localStorage/sessionStorage value previews. Defaults to false; use only when the user asks for app state details."
        }
      }
    }
  },
  {
    name: "browser_click",
    description: "Click a deterministic page target selected by elementRef, selector, role/name, label, placeholder, or text.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        tabId: {
          type: "number"
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            elementRef: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            placeholder: { type: "string" },
            text: { type: "string" },
            index: { type: "number" }
          }
        },
        waitMs: {
          type: "number",
          description: "Post-action settle delay in milliseconds. Defaults to 300."
        },
        includeObservation: {
          type: "boolean",
          description: "Include a fresh observation after the action. Defaults to true."
        }
      }
    }
  },
  {
    name: "browser_type",
    description: "Type deterministic text into an editable page target. Password and file inputs are refused.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["target", "text"],
      properties: {
        tabId: {
          type: "number"
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            elementRef: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            placeholder: { type: "string" },
            text: { type: "string" },
            index: { type: "number" }
          }
        },
        text: {
          type: "string"
        },
        clear: {
          type: "boolean",
          description: "Clear the existing value before typing. Defaults to true."
        },
        waitMs: {
          type: "number"
        },
        includeObservation: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_select",
    description: "Select an option in a select control by exact value or visible option text.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        tabId: {
          type: "number"
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            elementRef: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            placeholder: { type: "string" },
            text: { type: "string" },
            index: { type: "number" }
          }
        },
        value: {
          type: "string"
        },
        optionText: {
          type: "string"
        },
        waitMs: {
          type: "number"
        },
        includeObservation: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_press_key",
    description: "Press a deterministic key on the current focus or on a selected page target.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        tabId: {
          type: "number"
        },
        key: {
          type: "string",
          description: "Key value such as Enter, Escape, Tab, ArrowDown, or Space."
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            elementRef: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            placeholder: { type: "string" },
            text: { type: "string" },
            index: { type: "number" }
          }
        },
        waitMs: {
          type: "number"
        },
        includeObservation: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_scroll_page",
    description: "Scroll the page or scroll a target element into view.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: {
          type: "number"
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            elementRef: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            placeholder: { type: "string" },
            text: { type: "string" },
            index: { type: "number" }
          }
        },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right", "top", "bottom"]
        },
        amount: {
          type: "number"
        },
        waitMs: {
          type: "number"
        },
        includeObservation: {
          type: "boolean"
        }
      }
    }
  },
  {
    name: "browser_wait_for",
    description: "Wait until deterministic page conditions are true: selector state, text, URL substring, or title substring.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["condition"],
      properties: {
        tabId: {
          type: "number"
        },
        condition: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            urlIncludes: { type: "string" },
            titleIncludes: { type: "string" },
            elementState: {
              type: "string",
              enum: ["present", "visible", "hidden", "absent"]
            }
          }
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait time. Defaults to 5000."
        }
      }
    }
  },
  {
    name: "browser_assert_page",
    description: "Assert deterministic page conditions immediately and fail the tool if they are not true.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["condition"],
      properties: {
        tabId: {
          type: "number"
        },
        condition: {
          type: "object",
          additionalProperties: false,
          properties: {
            selector: { type: "string" },
            text: { type: "string" },
            urlIncludes: { type: "string" },
            titleIncludes: { type: "string" },
            elementState: {
              type: "string",
              enum: ["present", "visible", "hidden", "absent"]
            }
          }
        }
      }
    }
  },
  {
    name: "web_search",
    description: "Run a search for a query and optionally snapshot the visible results. Use searchType \"images\" for explicit visual requests such as photos, image references, famous artwork, photographer portfolios, or requests to see many images. Set background true to run the search in an inactive tab (the results page is not shown to the user).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string"
        },
        searchType: {
          type: "string",
          enum: ["web", "images"],
          description: "Defaults to web. Use images when the user wants visual/image/photo results rather than text sources."
        },
        minImages: {
          type: "number",
          description: "For image searches, try to collect at least this many visible image results. Defaults to 24."
        },
        includeSnapshot: {
          type: "boolean"
        },
        background: {
          type: "boolean",
          description: "Run the search in an inactive tab so the results page is not shown to the user. Defaults to false."
        },
        maxChars: {
          type: "number"
        }
      }
    }
  },
  {
    name: "browser_extract_page",
    description: "Extract readable page text, headings, links, article metadata, tables, code blocks, forms, and price-like values.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: {
          type: "number"
        },
        maxChars: {
          type: "number"
        },
        includeLinks: {
          type: "boolean"
        },
        includeStructured: {
          type: "boolean",
          description: "Include selected text, article metadata, tables, code blocks, forms, and price-like values."
        }
      }
    }
  },
  {
    name: "browser_find_in_page",
    description: "Find matching page passages.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string"
        },
        tabId: {
          type: "number"
        },
        maxMatches: {
          type: "number"
        }
      }
    }
  },
  {
    name: "browser_capture_network",
    description: "Capture live network traffic (XHR/fetch/WebSocket) from a tab using the page-shim capture path. Use for reverse-engineering a site's API design, data models, and auth patterns. Workflow: start (then reload or interact with the page), then summary for a compact overview, then dump for raw entries. Sensitive values (JWTs, cookies, authorization headers, API keys) are tagged in the summary and returned un-redacted by dump. Full Chrome debugger/CDP capture is disabled in this build because Chrome does not allow debugger as an optional permission.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "tabId"],
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "summary", "dump"],
          description: "start attaches capture; stop detaches but keeps the buffer; summary returns a compact aggregate; dump returns raw filtered requests."
        },
        tabId: {
          type: "number",
          description: "Target tab id from browser_list_tabs. Required."
        },
        urlIncludes: {
          type: "string",
          description: "dump only: case-insensitive substring filter on request URL."
        },
        methods: {
          type: "array",
          items: { type: "string" },
          description: "dump only: filter to these HTTP methods (e.g. POST, GET)."
        },
        onlySensitive: {
          type: "boolean",
          description: "dump only: return only requests that contain tagged credentials."
        },
        includeBodies: {
          type: "boolean",
          description: "dump only: include request/response bodies. Defaults to true."
        },
        maxRequests: {
          type: "number",
          description: "dump only: maximum requests to return (latest first). Defaults to 50, capped at 500."
        }
      }
    }
  },
  {
    name: "fs_get_workspace",
    description: "Check the connected local workspace folder and its current read/write permission state.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "fs_list_directory",
    description: "List files and folders inside the connected local workspace. Paths are relative to the workspace root.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Relative directory path. Omit or use an empty string for the workspace root."
        },
        recursive: {
          type: "boolean",
          description: "Whether to descend into child directories."
        },
        maxEntries: {
          type: "number",
          description: "Maximum entries to return."
        }
      }
    }
  },
  {
    name: "fs_read_file",
    description: "Read a bounded text excerpt from the connected local workspace. Paths are relative to the workspace root and cannot escape it.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string"
        },
        maxChars: {
          type: "number",
          description: "Maximum text characters to return."
        },
        maxBytes: {
          type: "number",
          description: "Maximum file size to read before rejecting the file."
        },
        lineRange: {
          type: "object",
          additionalProperties: false,
          description: "Optional 1-based line range to inspect.",
          properties: {
            start: { type: "number" },
            end: { type: "number" }
          }
        }
      }
    }
  },
  {
    name: "fs_open_image",
    description: "Open a supported image file from the connected local workspace in a browser tab with fit-to-viewport sizing and no cropping.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative image path. Supports png, jpg, jpeg, gif, webp, avif, svg, and ico."
        },
        active: {
          type: "boolean",
          description: "Whether to focus the opened image viewer tab. Defaults to true."
        }
      }
    }
  },
  {
    name: "fs_search_files",
    description: "Search file names and text contents inside the connected local workspace.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string"
        },
        path: {
          type: "string",
          description: "Relative directory path to search from."
        },
        includeContent: {
          type: "boolean",
          description: "Search readable file contents in addition to names."
        },
        maxResults: {
          type: "number"
        },
        maxBytes: {
          type: "number",
          description: "Maximum size per file to search before skipping that file."
        }
      }
    }
  },
  {
    name: "fs_write_file",
    description: "Create or overwrite a text file inside the connected local workspace. Paths are relative to the workspace root.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: {
          type: "string"
        },
        content: {
          type: "string"
        },
        createParents: {
          type: "boolean",
          description: "Create parent folders when missing. Defaults to true."
        }
      }
    }
  }
];
