import { describe, expect, it } from "vitest";
import { detectFastPathIntent } from "./interactionFastPath";

describe("detectFastPathIntent", () => {
  it("detects a click with a target phrase", () => {
    expect(detectFastPathIntent("click the sign in button")).toEqual({ action: "click", query: "sign in" });
    expect(detectFastPathIntent("tap the menu icon")).toMatchObject({ action: "click" });
  });

  it("prefers a quoted target phrase verbatim", () => {
    expect(detectFastPathIntent('click the "Save & Continue" button')).toEqual({ action: "click", query: "Save & Continue" });
  });

  it("detects a type action and extracts the value + target field", () => {
    const intent = detectFastPathIntent('type "hello@example.com" into the email field');
    expect(intent?.action).toBe("type");
    expect(intent?.text).toBe("hello@example.com");
    expect(intent?.query).toContain("email");
  });

  it("detects a scroll-to-element intent (read-only, fireable)", () => {
    expect(detectFastPathIntent("scroll to the pricing link")).toMatchObject({
      action: "scroll",
      query: "pricing",
      targetKind: "link"
    });
  });

  it("detects a read intent on the page", () => {
    expect(detectFastPathIntent("read the article on this page")?.action).toBe("read");
  });

  it("does NOT fire for non-page prompts", () => {
    expect(detectFastPathIntent("what is the 3rd planet from the sun")).toBeUndefined();
    expect(detectFastPathIntent("explain how neural networks work")).toBeUndefined();
    expect(detectFastPathIntent("")).toBeUndefined();
  });

  it("STRONG verbs qualify without a target noun (grep decides the element)", () => {
    // "click pricing" has no "button"/"link" word but is obviously an interaction;
    // the gate qualifies it and the grep resolves "pricing".
    expect(detectFastPathIntent("click pricing")).toEqual({ action: "click", query: "pricing" });
    expect(detectFastPathIntent("click log in")).toEqual({ action: "click", query: "log in" });
    expect(detectFastPathIntent("click products")).toEqual({ action: "click", query: "products" });
  });

  it("keeps the click target separate from a follow-up reporting clause", () => {
    expect(detectFastPathIntent("Click a navigation link on this page, then tell me what changed")).toEqual({
      action: "click",
      query: "navigation",
      targetKind: "link"
    });
    expect(detectFastPathIntent("click pricing and tell me what changed")).toEqual({
      action: "click",
      query: "pricing"
    });
  });

  it("WEAK verbs require a page/target reference (avoid hijacking non-page intents)", () => {
    // "open"/"read" are ambiguous with non-page requests.
    expect(detectFastPathIntent("open my email")).toBeUndefined();
    expect(detectFastPathIntent("read War and Peace")).toBeUndefined();
    // ...but qualify with a page/target reference.
    expect(detectFastPathIntent("open the pricing page")?.action).toBe("click");
  });

  it("does NOT fire for broad research prompts", () => {
    expect(detectFastPathIntent("research the best laptops of 2025")).toBeUndefined();
  });
});
