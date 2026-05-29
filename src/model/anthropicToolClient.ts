import type { AppSettings } from "../settings/settingsStore";
import { clipWithTruncation as clip } from "../shared/textUtils";
import type { AnthropicToolSchema } from "../tools/browserToolList";

export type AnthropicTextBlock = {
  type: "text";
  text: string;
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicMessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type AnthropicErrorResponse = {
  error?: {
    type?: string;
    message?: string;
  };
};

type AnthropicMessageRequestArgs = {
  settings: AppSettings;
  model?: string;
  system: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolSchema[];
  signal?: AbortSignal;
};

type AnthropicStreamEvent = {
  type?: unknown;
  message?: unknown;
  index?: unknown;
  content_block?: unknown;
  delta?: unknown;
  usage?: unknown;
  error?: unknown;
};

const MAX_API_TEXT_MESSAGE_CHARS = Number.MAX_SAFE_INTEGER;
const MAX_API_TEXT_BLOCK_CHARS = Number.MAX_SAFE_INTEGER;
const MAX_API_TOOL_RESULT_CHARS = Number.MAX_SAFE_INTEGER;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export class AnthropicClientError extends Error {
  constructor(
    public readonly code: "missing_api_key" | "network_error" | "api_error" | "empty_response",
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AnthropicClientError";
  }
}

export async function callAnthropicMessage(args: {
  settings: AppSettings;
  model?: string;
  system: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolSchema[];
  signal?: AbortSignal;
}): Promise<AnthropicMessageResponse> {
  const apiKey = requireApiKey(args.settings);
  const model = args.model ?? args.settings.model.model;
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: args.signal,
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify(buildRequestBody(args, model))
    });
  } catch (error) {
    throw new AnthropicClientError(
      "network_error",
      error instanceof Error ? error.message : "Network error while calling Anthropic.",
      error
    );
  }

  const json = await safeReadJson(response);
  if (!response.ok) {
    const apiError = (json as AnthropicErrorResponse).error;
    throw new AnthropicClientError(
      "api_error",
      apiError?.message ?? `Anthropic API returned HTTP ${response.status}.`,
      json
    );
  }

  const message = json as AnthropicMessageResponse;
  if (!Array.isArray(message.content)) {
    throw new AnthropicClientError("empty_response", "Anthropic returned no content blocks.", json);
  }

  return {
    ...message,
    content: message.content.filter(isSupportedContentBlock)
  };
}

export async function streamAnthropicMessage(args: AnthropicMessageRequestArgs & {
  onTextDelta?: (delta: string) => void;
}): Promise<AnthropicMessageResponse> {
  const apiKey = requireApiKey(args.settings);
  const model = args.model ?? args.settings.model.model;
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: args.signal,
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify(buildRequestBody(args, model, true))
    });
  } catch (error) {
    throw new AnthropicClientError(
      "network_error",
      error instanceof Error ? error.message : "Network error while calling Anthropic.",
      error
    );
  }

  if (!response.ok) {
    const json = await safeReadJson(response);
    const apiError = (json as AnthropicErrorResponse).error;
    throw new AnthropicClientError(
      "api_error",
      apiError?.message ?? `Anthropic API returned HTTP ${response.status}.`,
      json
    );
  }

  if (!response.body) {
    throw new AnthropicClientError("empty_response", "Anthropic returned an empty streaming response.");
  }

  try {
    return await readAnthropicMessageStream(response.body, model, args.onTextDelta);
  } catch (error) {
    if (error instanceof AnthropicClientError) {
      throw error;
    }

    throw new AnthropicClientError(
      "network_error",
      error instanceof Error ? error.message : "Network error while reading Anthropic stream.",
      error
    );
  }
}

export function extractText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function parseAnthropicSseEventBlock(block: string): AnthropicStreamEvent | undefined {
  const dataLines = block
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  const data = dataLines.join("\n").trim();

  if (!data || data === "[DONE]") {
    return undefined;
  }

  const parsed = JSON.parse(data) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

async function readAnthropicMessageStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  onTextDelta?: (delta: string) => void
): Promise<AnthropicMessageResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const content: AnthropicContentBlock[] = [];
  const toolInputJsonByIndex = new Map<number, string>();
  let buffer = "";
  let sawMessageStart = false;
  let finalMessage: AnthropicMessageResponse = {
    id: "",
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: []
  };

  async function processBuffer(flush = false): Promise<void> {
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let separatorIndex = buffer.indexOf("\n\n");

    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      processStreamEventBlock(block);
      separatorIndex = buffer.indexOf("\n\n");
    }

    if (flush && buffer.trim()) {
      processStreamEventBlock(buffer);
      buffer = "";
    }
  }

  function processStreamEventBlock(block: string): void {
    let event: AnthropicStreamEvent | undefined;
    try {
      event = parseAnthropicSseEventBlock(block);
    } catch (error) {
      throw new AnthropicClientError("api_error", "Could not parse Anthropic streaming event.", {
        block,
        error
      });
    }

    if (!event) {
      return;
    }

    processStreamEvent(event);
  }

  function processStreamEvent(event: AnthropicStreamEvent): void {
    if (event.type === "message_start") {
      sawMessageStart = true;
      const message = isRecord(event.message) ? event.message : {};
      finalMessage = {
        id: typeof message.id === "string" ? message.id : finalMessage.id,
        type: "message",
        role: "assistant",
        model: typeof message.model === "string" ? message.model : finalMessage.model,
        content,
        stop_reason: typeof message.stop_reason === "string" ? message.stop_reason : undefined,
        usage: usageFromValue(message.usage)
      };
      return;
    }

    if (event.type === "content_block_start") {
      const index = numericIndex(event.index);
      const block = isRecord(event.content_block) ? event.content_block : undefined;
      if (index === undefined || !block) {
        return;
      }

      if (block.type === "text") {
        content[index] = {
          type: "text",
          text: typeof block.text === "string" ? block.text : ""
        };
        return;
      }

      if (block.type === "tool_use") {
        content[index] = {
          type: "tool_use",
          id: typeof block.id === "string" ? block.id : "",
          name: typeof block.name === "string" ? block.name : "",
          input: isRecord(block.input) ? block.input : {}
        };
        toolInputJsonByIndex.set(index, "");
      }
      return;
    }

    if (event.type === "content_block_delta") {
      const index = numericIndex(event.index);
      const delta = isRecord(event.delta) ? event.delta : undefined;
      if (index === undefined || !delta) {
        return;
      }

      if (delta.type === "text_delta" && typeof delta.text === "string") {
        appendTextDelta(content, index, delta.text);
        onTextDelta?.(delta.text);
        return;
      }

      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        toolInputJsonByIndex.set(index, `${toolInputJsonByIndex.get(index) ?? ""}${delta.partial_json}`);
      }
      return;
    }

    if (event.type === "content_block_stop") {
      const index = numericIndex(event.index);
      if (index !== undefined) {
        finalizeToolInput(content, index, toolInputJsonByIndex.get(index));
      }
      return;
    }

    if (event.type === "message_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      if (typeof delta.stop_reason === "string") {
        finalMessage.stop_reason = delta.stop_reason;
      }

      finalMessage.usage = usageFromValue(event.usage) ?? finalMessage.usage;
      return;
    }

    if (event.type === "error") {
      const error = isRecord(event.error) ? event.error : {};
      throw new AnthropicClientError(
        "api_error",
        typeof error.message === "string" ? error.message : "Anthropic returned a streaming error.",
        event
      );
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      await processBuffer(true);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    await processBuffer();
  }

  if (!sawMessageStart && !content.length) {
    throw new AnthropicClientError("empty_response", "Anthropic returned no streaming message content.");
  }

  return {
    ...finalMessage,
    content: content.filter(isSupportedContentBlock)
  };
}

function requireApiKey(settings: AppSettings): string {
  const apiKey = settings.provider.apiKey?.trim();
  if (!apiKey) {
    throw new AnthropicClientError(
      "missing_api_key",
      "Anthropic API key is missing. Add it in Settings to enable Claude."
    );
  }

  return apiKey;
}

function anthropicHeaders(apiKey: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
}

function buildRequestBody(
  args: AnthropicMessageRequestArgs,
  model: string,
  stream?: boolean
): Record<string, unknown> {
  return {
    model,
    system: args.system,
    messages: normalizeMessages(args.messages),
    tools: args.tools?.length ? args.tools : undefined,
    tool_choice: args.tools?.length ? { type: "auto" } : undefined,
    max_tokens: args.settings.model.maxOutputTokens,
    temperature: args.settings.model.temperature,
    stream: stream || undefined
  };
}

function appendTextDelta(content: AnthropicContentBlock[], index: number, delta: string): void {
  const block = content[index];
  if (block?.type === "text") {
    block.text += delta;
    return;
  }

  content[index] = {
    type: "text",
    text: delta
  };
}

function finalizeToolInput(content: AnthropicContentBlock[], index: number, inputJson: string | undefined): void {
  const block = content[index];
  if (block?.type !== "tool_use" || !inputJson?.trim()) {
    return;
  }

  try {
    block.input = JSON.parse(inputJson) as unknown;
  } catch {
    block.input = {};
  }
}

function numericIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageFromValue(value: unknown): AnthropicMessageResponse["usage"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    input_tokens: typeof value.input_tokens === "number" ? value.input_tokens : undefined,
    output_tokens: typeof value.output_tokens === "number" ? value.output_tokens : undefined
  };
}

function normalizeMessages(messages: AnthropicMessageParam[]): AnthropicMessageParam[] {
  const normalized = collapseConsecutiveTextMessages(messages).map(clipMessageContent).filter((message) => {
    if (typeof message.content === "string") {
      return message.content.trim();
    }

    return message.content.length > 0;
  });

  if (!normalized.length || normalized[0].role !== "user") {
    normalized.unshift({
      role: "user",
      content: "Continue the conversation."
    });
  }

  return normalized;
}

function clipMessageContent(message: AnthropicMessageParam): AnthropicMessageParam {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: clip(message.content, MAX_API_TEXT_MESSAGE_CHARS)
    };
  }

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "text") {
        return {
          ...block,
          text: clip(block.text, MAX_API_TEXT_BLOCK_CHARS)
        };
      }

      if (block.type === "tool_result") {
        return {
          ...block,
          content: clip(block.content, MAX_API_TOOL_RESULT_CHARS)
        };
      }

      return block;
    })
  };
}

function collapseConsecutiveTextMessages(messages: AnthropicMessageParam[]): AnthropicMessageParam[] {
  const collapsed: AnthropicMessageParam[] = [];

  for (const message of messages) {
    const previous = collapsed[collapsed.length - 1];
    if (
      previous &&
      previous.role === message.role &&
      typeof previous.content === "string" &&
      typeof message.content === "string"
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }

    collapsed.push({
      role: message.role,
      content: Array.isArray(message.content) ? [...message.content] : message.content
    });
  }

  return collapsed;
}

function isSupportedContentBlock(block: unknown): block is AnthropicContentBlock {
  if (typeof block !== "object" || block === null) {
    return false;
  }

  const candidate = block as { type?: unknown };
  return candidate.type === "text" || candidate.type === "tool_use" || candidate.type === "tool_result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
