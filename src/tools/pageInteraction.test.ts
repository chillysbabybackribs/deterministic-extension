import { describe, expect, it } from "vitest";
import { HAIKU_BROWSER_TOOLS } from "./browserToolList";
import {
  hasPageActionTarget,
  hasPageCondition,
  normalizePageActionTarget,
  normalizePageCondition
} from "./pageInteraction";

describe("page interaction tool foundation", () => {
  it("exposes deterministic page interaction tools to the model tool list", () => {
    const names = HAIKU_BROWSER_TOOLS.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "browser_observe_page",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_press_key",
      "browser_scroll_page",
      "browser_wait_for",
      "browser_assert_page"
    ]));
  });

  it("normalizes action targets from nested or top-level input", () => {
    expect(normalizePageActionTarget({
      target: {
        elementRef: " css:button#save ",
        role: " button ",
        name: " Save ",
        index: 2.8
      }
    })).toEqual({
      elementRef: "css:button#save",
      role: "button",
      name: "Save",
      index: 2
    });

    expect(normalizePageActionTarget({
      selector: " input[name='email'] ",
      placeholder: " Email "
    })).toEqual({
      selector: "input[name='email']",
      placeholder: "Email"
    });
    expect(hasPageActionTarget(normalizePageActionTarget({}))).toBe(false);
  });

  it("accepts a deterministic overlayIndex target and treats it as a valid target", () => {
    expect(normalizePageActionTarget({ overlayIndex: 5 })).toEqual({ overlayIndex: 5 });
    // Floors, and requires >= 1; sub-1 / non-finite are rejected.
    expect(normalizePageActionTarget({ overlayIndex: 5.9 })).toEqual({ overlayIndex: 5 });
    expect(normalizePageActionTarget({ overlayIndex: 0 })).toEqual({});
    expect(hasPageActionTarget(normalizePageActionTarget({ overlayIndex: 3 }))).toBe(true);
    // overlayIndex can coexist with heuristic fields (used as fallback).
    expect(normalizePageActionTarget({ overlayIndex: 2, text: " Save " })).toEqual({
      overlayIndex: 2,
      text: "Save"
    });
  });

  it("normalizes conditions and defaults selector checks to visible", () => {
    expect(normalizePageCondition({
      condition: {
        selector: " .toast ",
        text: " Saved ",
        elementState: "present"
      }
    })).toEqual({
      selector: ".toast",
      text: "Saved",
      elementState: "present"
    });

    expect(normalizePageCondition({ selector: "#ready" })).toEqual({
      selector: "#ready",
      elementState: "visible"
    });
    expect(hasPageCondition(normalizePageCondition({}))).toBe(false);
  });
});
