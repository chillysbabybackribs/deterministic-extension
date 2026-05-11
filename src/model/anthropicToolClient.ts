import type { AppSettings } from "../settings/settingsStore";
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

const MAX_API_TEXT_MESSAGE_CHARS = 6_000;
const MAX_API_TEXT_BLOCK_CHARS = 4_000;
const MAX_API_TOOL_RESULT_CHARS = 4_000;

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
  system: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolSchema[];
}): Promise<AnthropicMessageResponse> {
  const apiKey = args.settings.provider.apiKey?.trim();
  if (!apiKey) {
    throw new AnthropicClientError(
      "missing_api_key",
      "Anthropic API key is missing. Add it in Settings to enable Claude Haiku 4.5."
    );
  }

  const baseUrl = normalizeBaseUrl(args.settings.provider.baseUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: args.settings.model.model,
        system: args.system,
        messages: normalizeMessages(args.messages),
        tools: args.tools?.length ? args.tools : undefined,
        tool_choice: args.tools?.length ? { type: "auto" } : undefined,
        max_tokens: args.settings.model.maxOutputTokens,
        temperature: args.settings.model.temperature
      })
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

export function extractText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function extractToolUses(blocks: AnthropicContentBlock[]): AnthropicToolUseBlock[] {
  return blocks.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use");
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
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

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 28))}\n[truncated ${value.length - maxChars + 28} chars]`;
}

function isSupportedContentBlock(block: unknown): block is AnthropicContentBlock {
  if (typeof block !== "object" || block === null) {
    return false;
  }

  const candidate = block as { type?: unknown };
  return candidate.type === "text" || candidate.type === "tool_use" || candidate.type === "tool_result";
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
