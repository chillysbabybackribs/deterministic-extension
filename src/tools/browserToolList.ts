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
  | "browser_navigate_active_tab"
  | "web_search"
  | "browser_extract_page"
  | "browser_find_in_page"
  | "browser_history_search"
  | "browser_group_tabs"
  | "browser_close_tabs";

export const HAIKU_BROWSER_TOOLS: AnthropicToolSchema[] = [
  {
    name: "browser_read_active_tab",
    description: "Read active tab metadata or snapshot.",
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
    description: "Open an http(s) URL in a tab.",
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
        }
      }
    }
  },
  {
    name: "browser_extract_page",
    description: "Extract readable page text/headings/links.",
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
    name: "browser_history_search",
    description: "Search recent browser history.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string"
        },
        maxResults: {
          type: "number"
        },
        daysBack: {
          type: "number"
        }
      }
    }
  },
  {
    name: "browser_group_tabs",
    description: "Group tabs.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tabIds", "title"],
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" }
        },
        title: {
          type: "string"
        },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]
        }
      }
    }
  },
  {
    name: "browser_close_tabs",
    description: "Close tabs.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tabIds"],
      properties: {
        tabIds: {
          type: "array",
          items: { type: "number" }
        }
      }
    }
  }
];
