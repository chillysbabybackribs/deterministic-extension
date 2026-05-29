import { describe, expect, it } from "vitest";
import { visibleMessageWarnings } from "./MessageList";

describe("visibleMessageWarnings", () => {
  it("hides a warning that repeats the assistant message body", () => {
    expect(visibleMessageWarnings({
      content: "This extension does not currently support close tab actions.",
      warnings: ["This extension does not currently support close tab actions."]
    })).toEqual([]);
  });

  it("keeps distinct warning details and removes duplicate warnings", () => {
    expect(visibleMessageWarnings({
      content: "Opened https://example.com.",
      warnings: [
        "The page snapshot was partial.",
        "The page snapshot was partial.",
        "Search was blocked."
      ]
    })).toEqual([
      "The page snapshot was partial.",
      "Search was blocked."
    ]);
  });
});
