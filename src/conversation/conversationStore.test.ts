import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation, ChatMessage } from "./conversationTypes";
import { clearChatHistory, loadChatHistory, saveChatHistory } from "./conversationStore";
import type { CapturedUiDisplaySummary } from "../tools/pageCapture";

const CHAT_HISTORY_KEY = "ohmygod.chatHistory.v2";
const LEGACY_CHAT_HISTORY_KEY = "ohmygod.chatHistory.v1";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("conversationStore", () => {
  it("saves normalized conversations and loads them back from local storage", async () => {
    const messageWithEvidence = message("m2", "assistant", "Answer", "2026-05-10T10:01:00.000Z");
    messageWithEvidence.evidencePacket = { id: "evidence" } as ChatMessage["evidencePacket"];
    messageWithEvidence.warnings = ["one", "two", "three", "four", "five", "six"];

    await saveChatHistory({
      activeConversationId: "missing",
      conversations: [
        conversation("older", "Older", "2026-05-09T10:00:00.000Z", [
          message("m0", "user", "Older chat", "2026-05-09T10:00:00.000Z")
        ]),
        conversation("newer", "Newer", "2026-05-10T10:01:00.000Z", [
          message("m1", "user", "Question", "2026-05-10T10:00:00.000Z"),
          messageWithEvidence
        ])
      ]
    });

    const raw = JSON.parse(storage.getItem(CHAT_HISTORY_KEY) ?? "{}") as {
      activeConversationId?: string;
      conversations: Array<{ id: string; messages: Array<Record<string, unknown>> }>;
    };
    expect(raw.activeConversationId).toBe("newer");
    expect(raw.conversations.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(raw.conversations[0].messages[1]).not.toHaveProperty("evidencePacket");
    expect(raw.conversations[0].messages[1].warnings).toHaveLength(5);

    const loaded = await loadChatHistory();
    expect(loaded.activeConversationId).toBe("newer");
    expect(loaded.conversations.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(loaded.conversations[0].messages.map((item) => item.content)).toEqual(["Question", "Answer"]);
  });

  it("migrates legacy single-chat history when no v2 history exists", async () => {
    storage.setItem(LEGACY_CHAT_HISTORY_KEY, JSON.stringify({
      version: 1,
      updatedAt: "2026-05-10T08:00:00.000Z",
      messages: [
        { role: "nope", content: "invalid" },
        message("m1", "user", "What is ADK?", "2026-05-10T08:00:00.000Z"),
        message("m2", "assistant", "Agent Development Kit", "2026-05-10T08:01:00.000Z")
      ]
    }));

    const loaded = await loadChatHistory();

    expect(loaded.conversations).toHaveLength(1);
    expect(loaded.activeConversationId).toBe(loaded.conversations[0].id);
    expect(loaded.conversations[0].title).toBe("What is ADK?");
    expect(loaded.conversations[0].messages.map((item) => item.role)).toEqual(["user", "assistant"]);
  });

  it("persists captured UI card summaries without storing the full capture payload", async () => {
    const captureMessage = message(
      "m1",
      "user",
      [
        "Captured UI: <a> Home page link",
        "Source: Claude - Use cases page",
        "Selector: a[aria-label=\"Home page\"] (high confidence)"
      ].join("\n"),
      "2026-05-10T10:00:00.000Z"
    );
    captureMessage.captureSummary = captureSummaryFixture();

    await saveChatHistory({
      activeConversationId: "capture-chat",
      conversations: [
        conversation("capture-chat", "Capture", "2026-05-10T10:00:00.000Z", [captureMessage])
      ]
    });

    const raw = JSON.parse(storage.getItem(CHAT_HISTORY_KEY) ?? "{}") as {
      conversations: Array<{ messages: Array<Record<string, unknown>> }>;
    };
    const storedMessage = raw.conversations[0].messages[0];

    expect(storedMessage.captureSummary).toMatchObject({
      title: "Captured UI",
      elementDescription: "Home page link",
      selectorConfidence: "high",
      component: {
        kind: "link",
        intent: "navigation",
        confidence: "high"
      }
    });
    expect(JSON.stringify(storedMessage)).not.toContain("computedStyle");
    expect(JSON.stringify(storedMessage)).not.toContain("captureId");

    const loaded = await loadChatHistory();
    expect(loaded.conversations[0].messages[0].captureSummary).toMatchObject({
      title: "Captured UI",
      hitElement: "<path> inside SVG, promoted to <a>"
    });
  });

  it("preserves activity timing and token diagnostics", async () => {
    const chat = conversation("diagnostics", "Diagnostics", "2026-05-10T10:00:00.000Z", [
      message("m1", "user", "Hello", "2026-05-10T10:00:00.000Z")
    ]);
    chat.activity = [{
      id: "log_1",
      timestamp: "2026-05-10T10:00:01.000Z",
      level: "info",
      label: "Haiku 4.5",
      details: "Returned a final answer.",
      toolName: "claude-haiku-4-5",
      actionLabel: "Model answer",
      status: "completed",
      eventType: "tool",
      startedAt: "2026-05-10T10:00:00.000Z",
      endedAt: "2026-05-10T10:00:01.250Z",
      durationMs: 1250,
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        totalTokens: 1290
      }
    }];

    await saveChatHistory({
      activeConversationId: "diagnostics",
      conversations: [chat]
    });

    const loaded = await loadChatHistory();
    expect(loaded.conversations[0].activity[0]).toMatchObject({
      startedAt: "2026-05-10T10:00:00.000Z",
      endedAt: "2026-05-10T10:00:01.250Z",
      durationMs: 1250,
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        totalTokens: 1290
      }
    });
  });

  it("clears both current and legacy history keys", async () => {
    storage.setItem(CHAT_HISTORY_KEY, "{}");
    storage.setItem(LEGACY_CHAT_HISTORY_KEY, "{}");

    await clearChatHistory();

    expect(storage.getItem(CHAT_HISTORY_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_CHAT_HISTORY_KEY)).toBeNull();
  });
});

function captureSummaryFixture(): CapturedUiDisplaySummary {
  return {
    title: "Captured UI",
    subtitle: "Home page link",
    sourceTitle: "Claude - Use cases page",
    sourceUrl: "https://claude.ai/use-cases",
    sourceDomain: "claude.ai",
    elementLabel: "Home page",
    elementDescription: "Home page link",
    selector: "a[aria-label=\"Home page\"]",
    selectorConfidence: "high",
    tagName: "a",
    role: "link",
    bounds: {
      width: 120,
      height: 84
    },
    styleSummary: {
      font: "Anthropic Sans 20px",
      color: "#faf9f5",
      background: "transparent"
    },
    semanticContext: "Link target: /",
    hitElement: "<path> inside SVG, promoted to <a>",
    component: {
      kind: "link",
      intent: "navigation",
      confidence: "high",
      templateHints: ["prefer local Link/NavLink primitive when available"],
      limitations: ["raw hit <path> was promoted to semantic <a>"]
    }
  };
}

function conversation(
  id: string,
  title: string,
  updatedAt: string,
  messages: ChatMessage[]
): ChatConversation {
  return {
    id,
    title,
    createdAt: messages[0]?.createdAt ?? updatedAt,
    updatedAt,
    messages,
    activity: []
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string
): ChatMessage {
  return {
    id,
    role,
    content,
    createdAt,
    status: "complete"
  };
}
