import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../settings/settingsStore";
import {
  callAnthropicMessage,
  extractText,
  parseAnthropicSseEventBlock,
  streamAnthropicMessage
} from "./anthropicToolClient";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callAnthropicMessage", () => {
  it("always calls Anthropic's official Messages endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: DEFAULT_APP_SETTINGS.model.model,
        content: [
          {
            type: "text",
            text: "ok"
          }
        ]
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const legacySettings = {
      ...DEFAULT_APP_SETTINGS,
      provider: {
        ...DEFAULT_APP_SETTINGS.provider,
        apiKey: "sk-test",
        baseUrl: "https://example.invalid"
      }
    } as AppSettings;

    await callAnthropicMessage({
      settings: legacySettings,
      system: "system",
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("parses Anthropic SSE text deltas", () => {
    const event = parseAnthropicSseEventBlock([
      "event: content_block_delta",
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}"
    ].join("\n"));

    expect(event).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "Hello"
      }
    });
  });

  it("streams text deltas and returns the accumulated message", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [
          "event: message_start\n",
          `data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"${DEFAULT_APP_SETTINGS.model.model}","content":[],"usage":{"input_tokens":12}}}\n\n`,
          "event: content_block_start\n",
          "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
          "event: content_block_delta\n",
          "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
          "event: content_block_delta\n",
          "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
          "event: message_delta\n",
          "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
          "event: message_stop\n",
          "data: {\"type\":\"message_stop\"}\n\n"
        ]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        }
      })
    );
    const deltas: string[] = [];

    const response = await streamAnthropicMessage({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        provider: {
          ...DEFAULT_APP_SETTINGS.provider,
          apiKey: "sk-test"
        }
      },
      system: "system",
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ],
      onTextDelta: (delta) => deltas.push(delta)
    });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(extractText(response.content)).toBe("Hello");
    expect(response.stop_reason).toBe("end_turn");
    expect(response.usage?.output_tokens).toBe(2);
  });
});
