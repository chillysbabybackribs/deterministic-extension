import { describe, expect, it } from "vitest";
import { chatContextFromMessages, isResearchProgressEvent, shouldKeepProgressOpenAfterResponse, typewriterTakeLength } from "./App";
import type { RunProgressEvent } from "../shared/protocol";
import type { ChatMessage } from "../conversation/conversationTypes";

describe("typewriterTakeLength", () => {
  it("prefers nearby word boundaries while streaming", () => {
    expect(typewriterTakeLength("hello world")).toBe(6);
  });

  it("falls back to character slicing when no boundary is nearby", () => {
    expect(typewriterTakeLength("helloworld")).toBe(6);
  });

  it("uses larger chunks while draining a completed answer", () => {
    const queue = "x".repeat(500);

    expect(typewriterTakeLength(queue, true)).toBeGreaterThan(typewriterTakeLength(queue));
  });
});

describe("isResearchProgressEvent", () => {
  it("keeps execution progress visible for user-facing work", () => {
    expect(isResearchProgressEvent(progressEvent("Current page"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Query"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Sufficiency"))).toBe(true);
  });

  it("shows model and browser execution progress events in the progress surface", () => {
    expect(isResearchProgressEvent(progressEvent("Model turn"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Model answer"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Browser search"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Browser action"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Run failed"))).toBe(true);
    expect(isResearchProgressEvent(progressEvent("Unsupported capability"))).toBe(true);
  });
});

describe("shouldKeepProgressOpenAfterResponse", () => {
  it("keeps the progress drawer closed unless the user has it open", () => {
    expect(shouldKeepProgressOpenAfterResponse(false, false)).toBe(false);
    expect(shouldKeepProgressOpenAfterResponse(false, true)).toBe(false);
    expect(shouldKeepProgressOpenAfterResponse(true, false)).toBe(false);
    expect(shouldKeepProgressOpenAfterResponse(true, true)).toBe(true);
  });
});

describe("chatContextFromMessages", () => {
  it("drops failed user turns so the next request is not treated as unfinished work", () => {
    const context = chatContextFromMessages([
      chatMessage("user", "close my tabs"),
      chatMessage(
        "assistant",
        "This extension does not currently support close tab actions.",
        "error"
      ),
      chatMessage("user", "open https://example.com"),
      chatMessage("assistant", "Opened https://example.com.")
    ]);

    expect(context).toEqual([
      { role: "user", content: "open https://example.com" },
      { role: "assistant", content: "Opened https://example.com." }
    ]);
  });

  it("keeps successful prior turns as normal context", () => {
    const context = chatContextFromMessages([
      chatMessage("user", "open https://example.com"),
      chatMessage("assistant", "Opened https://example.com."),
      chatMessage("user", "extract the heading")
    ]);

    expect(context).toEqual([
      { role: "user", content: "open https://example.com" },
      { role: "assistant", content: "Opened https://example.com." },
      { role: "user", content: "extract the heading" }
    ]);
  });
});

function progressEvent(label: string): RunProgressEvent {
  return {
    id: `progress-${label}`,
    timestamp: "2026-05-11T00:00:00.000Z",
    level: "info",
    label,
    detail: "test",
    status: "running"
  };
}

function chatMessage(
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "complete"
): ChatMessage {
  return {
    id: `message-${role}-${content}`,
    role,
    content,
    createdAt: "2026-05-12T00:00:00.000Z",
    status
  };
}
