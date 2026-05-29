import { describe, expect, it } from "vitest";
import { HAIKU_BROWSER_TOOLS, type BrowserToolName } from "./browserToolList";

describe("Haiku browser tool contract", () => {
  it("advertises every executable browser tool used by the direct tool loop", () => {
    const toolNames = new Set<BrowserToolName>(HAIKU_BROWSER_TOOLS.map((tool) => tool.name));

    expect(toolNames.has("web_search")).toBe(true);
    expect(toolNames.has("browser_extract_page")).toBe(true);
    expect(toolNames.has("browser_open_tab")).toBe(true);
    expect(toolNames.has("browser_group_tabs")).toBe(true);
    expect(toolNames.has("browser_navigate_active_tab")).toBe(true);
    expect(toolNames.has("browser_inspect_page_app")).toBe(true);
    expect(toolNames.has("browser_explore_page")).toBe(true);
    expect(toolNames.has("fs_open_image")).toBe(true);
  });

  it("does not advertise unsupported tab/history management tools", () => {
    const toolNames = new Set<string>(HAIKU_BROWSER_TOOLS.map((tool) => tool.name));

    expect(toolNames.has("browser_close_tab")).toBe(false);
    expect(toolNames.has("browser_prune_tabs")).toBe(false);
    expect(toolNames.has("browser_read_history")).toBe(false);
  });

  it("keeps tool schemas closed to undeclared arguments", () => {
    expect(HAIKU_BROWSER_TOOLS.every((tool) => tool.input_schema.additionalProperties === false)).toBe(true);
  });

  it("declares the direct search tool with required query input", () => {
    const searchTool = HAIKU_BROWSER_TOOLS.find((tool) => tool.name === "web_search");

    expect(searchTool).toBeDefined();
    expect(searchTool?.input_schema.required).toEqual(["query"]);
    expect(searchTool?.input_schema.properties).toHaveProperty("query");
    expect(searchTool?.input_schema.properties).toHaveProperty("searchType");
    expect(searchTool?.input_schema.properties).toHaveProperty("minImages");
    expect(searchTool?.input_schema.properties).toHaveProperty("includeSnapshot");
    expect(searchTool?.input_schema.properties).toHaveProperty("maxChars");
  });

  it("declares page app inspection for DOM and network evidence", () => {
    const inspectTool = HAIKU_BROWSER_TOOLS.find((tool) => tool.name === "browser_inspect_page_app");

    expect(inspectTool).toBeDefined();
    expect(inspectTool?.input_schema.properties).toHaveProperty("includeDomTree");
    expect(inspectTool?.input_schema.properties).toHaveProperty("includeNetwork");
    expect(inspectTool?.input_schema.properties).toHaveProperty("includeStorage");
    expect(inspectTool?.input_schema.properties).toHaveProperty("maxResources");
  });

  it("declares page exploration for mandatory interactive evidence", () => {
    const exploreTool = HAIKU_BROWSER_TOOLS.find((tool) => tool.name === "browser_explore_page");

    expect(exploreTool).toBeDefined();
    expect(exploreTool?.description).toContain("mandatory deep page exploration pipeline");
    expect(exploreTool?.input_schema.properties).not.toHaveProperty("maxDomNodes");
    expect(exploreTool?.input_schema.properties).not.toHaveProperty("maxResources");
  });
});
