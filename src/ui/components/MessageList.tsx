import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Check, Copy, Save } from "lucide-react";
import type { ChatMessage } from "../../conversation/conversationTypes";
import type { ProviderSettings } from "../../settings/providerSettings";
import type { CapturedUiDisplaySummary } from "../../tools/pageCapture";
import { MarkdownMessage } from "./MarkdownMessage";
import { CompanionOptInPill } from "./CompanionOptInPill";

const BOTTOM_LOCK_THRESHOLD = 72;
const FOLLOW_UP_SCROLL_DELAYS = [40, 120, 280];
const USER_MESSAGE_PIN_OFFSET = 270;
const PIN_FROZEN_RESERVE_FRACTION = 0.4;
const ANTHROPIC_API_KEYS_URL = "https://console.anthropic.com/settings/keys";
const GEMINI_API_KEYS_URL = "https://aistudio.google.com/apikey";
const OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys";

export type MessageListProps = {
  messages: ChatMessage[];
  busy: boolean;
  hideCaptureSummaries?: boolean;
  providerSettings: ProviderSettings;
  onSaveApiKeys: (keys: Pick<ProviderSettings, "apiKey" | "geminiApiKey" | "openaiApiKey">) => void | Promise<void>;
  /** True when the local companion engine is already connected (suppresses pills). */
  companionConnected?: boolean;
  /** Message ids whose opt-in pill the user dismissed this session. */
  dismissedGapMessageIds?: ReadonlySet<string>;
  /** Open the companion install/setup flow. */
  onInstallCompanion?: () => void;
  /** Dismiss the opt-in pill for a given message ("not now"). */
  onDismissGap?: (messageId: string) => void;
  /** Send a conversational deep-dive question (the pill's "ask the chat" button). */
  onAskCompanion?: (question: string) => void;
};

export function MessageList({
  messages,
  busy,
  hideCaptureSummaries = false,
  providerSettings,
  onSaveApiKeys,
  companionConnected = false,
  dismissedGapMessageIds,
  onInstallCompanion,
  onDismissGap,
  onAskCompanion
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();
  const timeoutRefs = useRef<number[]>([]);
  const shouldStickToBottomRef = useRef(true);
  const pinLatestUserMessageRef = useRef(false);
  const pinHasOverflowedRef = useRef(false);
  const previousMessageCountRef = useRef(messages.length);
  const copiedResetRef = useRef<number>();
  const [copiedMessageId, setCopiedMessageId] = useState<string>();

  const messageFingerprint = useMemo(
    () =>
      messages
        .map((message) => `${message.id}:${message.content.length}:${message.warnings?.length ?? 0}:${message.captureSummary?.selector ?? ""}`)
        .join("|"),
    [messages]
  );
  const lastMessageRole = messages.at(-1)?.role;
  const showThinking = busy && lastMessageRole === "user";
  const isEmpty = !busy && messages.length === 0;

  const clearScheduledScroll = useCallback(() => {
    if (frameRef.current !== undefined) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }

    for (const timeoutId of timeoutRefs.current) {
      window.clearTimeout(timeoutId);
    }
    timeoutRefs.current = [];
  }, []);

  const scrollToBottom = useCallback(() => {
    const list = listRef.current;
    if (!list || !shouldStickToBottomRef.current) {
      return;
    }

    if (pinLatestUserMessageRef.current) {
      if (pinHasOverflowedRef.current) {
        return;
      }

      const canContinuePinning = scrollToPinnedUserMessage(list);
      if (!canContinuePinning) {
        pinHasOverflowedRef.current = true;
      }
      return;
    }

    list.scrollTop = list.scrollHeight;
  }, []);

  const scheduleBottomScroll = useCallback(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }

    clearScheduledScroll();
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined;
      scrollToBottom();
    });
    timeoutRefs.current = FOLLOW_UP_SCROLL_DELAYS.map((delay) => window.setTimeout(scrollToBottom, delay));
  }, [clearScheduledScroll, scrollToBottom]);

  useLayoutEffect(() => {
    const messageCountChanged = messages.length !== previousMessageCountRef.current;
    const appendedUserMessage = messageCountChanged && lastMessageRole === "user";
    const currentlyStreamingAssistant = busy && lastMessageRole === "assistant";

    if (appendedUserMessage) {
      pinLatestUserMessageRef.current = true;
      pinHasOverflowedRef.current = false;
    } else if (currentlyStreamingAssistant && !pinHasOverflowedRef.current) {
      pinLatestUserMessageRef.current = true;
    }

    if (appendedUserMessage) {
      shouldStickToBottomRef.current = true;
    }

    previousMessageCountRef.current = messages.length;
    scheduleBottomScroll();
  }, [busy, lastMessageRole, messageFingerprint, messages.length, scheduleBottomScroll]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(scheduleBottomScroll);
    observer.observe(list);

    for (const child of Array.from(list.children)) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [messageFingerprint, scheduleBottomScroll]);

  useEffect(() => clearScheduledScroll, [clearScheduledScroll]);

  useEffect(() => {
    return () => {
      if (copiedResetRef.current !== undefined) {
        window.clearTimeout(copiedResetRef.current);
      }
    };
  }, []);

  function handleScroll() {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= BOTTOM_LOCK_THRESHOLD;
  }

  async function handleCopyResponse(content: string, messageId: string) {
    const copied = await copyTextToClipboard(content);
    if (!copied) {
      return;
    }

    setCopiedMessageId(messageId);
    if (copiedResetRef.current !== undefined) {
      window.clearTimeout(copiedResetRef.current);
    }
    copiedResetRef.current = window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? undefined : current);
      copiedResetRef.current = undefined;
    }, 1200);
  }

function scrollToPinnedUserMessage(list: HTMLDivElement) {
  const userMessages = Array.from(list.querySelectorAll<HTMLElement>("article.message.user"));
  const latestUserMessage = userMessages.at(-1);
  if (!latestUserMessage) {
    return true;
  }

  const assistantMessages = Array.from(list.querySelectorAll<HTMLElement>("article.message.assistant"));
  const latestAssistantMessage = assistantMessages.at(-1);

  if (latestAssistantMessage) {
    const responseHeight =
      latestAssistantMessage.offsetTop + latestAssistantMessage.offsetHeight - latestUserMessage.offsetTop;
    const visibleResponseCapacity =
      list.clientHeight - USER_MESSAGE_PIN_OFFSET + list.clientHeight * PIN_FROZEN_RESERVE_FRACTION;
    if (responseHeight > visibleResponseCapacity) {
      return false;
    }
  }

  const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  const targetScrollTop = Math.max(0, latestUserMessage.offsetTop - USER_MESSAGE_PIN_OFFSET);
  list.scrollTop = Math.min(targetScrollTop, maxScrollTop);
  return true;
}

  return (
    <div
      className={isEmpty ? "message-list empty-chat" : "message-list"}
      aria-live="polite"
      onScroll={handleScroll}
      ref={listRef}
    >
      {isEmpty ? <ApiKeySetup providerSettings={providerSettings} onSaveApiKeys={onSaveApiKeys} /> : null}
      {messages.filter((message) => !(hideCaptureSummaries && message.captureSummary)).map((message) => {
        const warnings = visibleMessageWarnings(message);
        const showPill = Boolean(
          message.role === "assistant" &&
          message.capabilityGap &&
          !companionConnected &&
          !dismissedGapMessageIds?.has(message.id)
        );
        const showCopy = message.role === "assistant" && !message.captureSummary && message.content.trim().length > 0;
        return (
          <article className={`message ${message.role} ${message.status ?? "complete"}${showPill ? " has-pill" : ""}`} key={message.id}>
            <div className="message-content">
              {message.captureSummary ? (
                <CapturedUiCard summary={message.captureSummary} />
              ) : message.role === "assistant" ? (
                <MarkdownMessage content={message.content} />
              ) : (
                message.content
              )}
            </div>
            {showCopy ? (
              // When a pill follows, the copy button moves into normal flow ABOVE
              // the pill (right-aligned); otherwise it stays anchored bottom-right.
              <button
                className={showPill ? "message-copy-button inline" : "message-copy-button"}
                type="button"
                title={copiedMessageId === message.id ? "Copied" : "Copy response"}
                aria-label={copiedMessageId === message.id ? "Copied response" : "Copy response"}
                onClick={() => void handleCopyResponse(message.content, message.id)}
              >
                {copiedMessageId === message.id ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={2} />}
              </button>
            ) : null}
            {warnings.length ? (
              <ul className="message-warnings">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {showPill && message.capabilityGap ? (
              <CompanionOptInPill
                gap={message.capabilityGap}
                onInstall={() => onInstallCompanion?.()}
                onDismiss={() => onDismissGap?.(message.id)}
                onAsk={(question) => onAskCompanion?.(question)}
              />
            ) : null}
          </article>
        );
      })}
      {showThinking ? (
        <article className="message assistant thinking" aria-label="Assistant is thinking">
          <div className="message-content">
            <span className="thinking-text">Thinking</span>
          </div>
        </article>
      ) : null}
      <div className="message-list-end" aria-hidden="true" />
    </div>
  );
}

export function visibleMessageWarnings(message: Pick<ChatMessage, "content" | "warnings">): string[] {
  const content = normalizeWarningText(message.content);
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const warning of message.warnings ?? []) {
    const normalized = normalizeWarningText(warning);
    if (!normalized || normalized === content || seen.has(normalized)) {
      continue;
    }

    warnings.push(warning);
    seen.add(normalized);
    if (warnings.length >= 3) {
      break;
    }
  }

  return warnings;
}

function normalizeWarningText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyText(text);
  }
}

function fallbackCopyText(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

type ApiKeyDrafts = Pick<ProviderSettings, "apiKey" | "geminiApiKey" | "openaiApiKey">;

function ApiKeySetup({
  providerSettings,
  onSaveApiKeys
}: {
  providerSettings: ProviderSettings;
  onSaveApiKeys: (keys: ApiKeyDrafts) => void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<ApiKeyDrafts>(() => ({
    apiKey: providerSettings.apiKey ?? "",
    geminiApiKey: providerSettings.geminiApiKey ?? "",
    openaiApiKey: providerSettings.openaiApiKey ?? ""
  }));
  const [savedKey, setSavedKey] = useState<keyof ApiKeyDrafts>();

  useEffect(() => {
    setDrafts({
      apiKey: providerSettings.apiKey ?? "",
      geminiApiKey: providerSettings.geminiApiKey ?? "",
      openaiApiKey: providerSettings.openaiApiKey ?? ""
    });
  }, [providerSettings.apiKey, providerSettings.geminiApiKey, providerSettings.openaiApiKey]);

  async function saveKey(key: keyof ApiKeyDrafts) {
    await onSaveApiKeys(drafts);
    setSavedKey(key);
    window.setTimeout(() => {
      setSavedKey((current) => current === key ? undefined : current);
    }, 1200);
  }

  const apiKeys = [
    {
      id: "emptyAnthropicApiKey",
      keyName: "apiKey" as const,
      label: "Anthropic API key",
      keyUrl: ANTHROPIC_API_KEYS_URL
    },
    {
      id: "emptyGeminiApiKey",
      keyName: "geminiApiKey" as const,
      label: "Gemini API key",
      keyUrl: GEMINI_API_KEYS_URL
    },
    {
      id: "emptyOpenaiApiKey",
      keyName: "openaiApiKey" as const,
      label: "OpenAI API key",
      keyUrl: OPENAI_API_KEYS_URL
    }
  ];

  return (
    <section className="api-key-setup" aria-label="API keys">
      {apiKeys.map((key) => {
        const savedProviderValue = providerSettings[key.keyName]?.trim() ?? "";
        return (
          <ApiKeyInput
            id={key.id}
            key={key.keyName}
            label={key.label}
            keyUrl={key.keyUrl}
            value={drafts[key.keyName] ?? ""}
            saved={savedKey === key.keyName}
            showKeyLink={!savedProviderValue}
            onChange={(value) => setDrafts((current) => ({ ...current, [key.keyName]: value }))}
            onSave={() => saveKey(key.keyName)}
          />
        );
      })}
    </section>
  );
}

function ApiKeyInput({
  id,
  label,
  keyUrl,
  showKeyLink,
  value,
  saved,
  onChange,
  onSave
}: {
  id: string;
  label: string;
  keyUrl: string;
  showKeyLink: boolean;
  value: string;
  saved: boolean;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
}) {
  return (
    <div className="api-key-row">
      <label htmlFor={id}>{label}</label>
      <div className="api-key-input-row">
        <input
          id={id}
          className={value ? undefined : "empty"}
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
        />
        <button type="button" onClick={onSave} title={`Save ${label}`} aria-label={`Save ${label}`}>
          <Save size={16} />
          <span>{saved ? "Saved" : "Save"}</span>
        </button>
        {showKeyLink ? (
          <a className="api-key-link" href={keyUrl} target="_blank" rel="noreferrer">
            Get your API key
          </a>
        ) : null}
      </div>
    </div>
  );
}

function CapturedUiCard({ summary }: { summary: CapturedUiDisplaySummary }) {
  const styleLine = formatStyleLine(summary.styleSummary);
  const source = formatSourceLine(summary);

  return (
    <section className="captured-ui-card" aria-label="Captured UI">
      <div className="captured-ui-card-header">
        <div>
          <div className="captured-ui-card-title">{summary.title}</div>
          <div className="captured-ui-card-subtitle">{summary.elementDescription}</div>
        </div>
        <span className={`captured-ui-confidence ${summary.selectorConfidence}`}>
          {summary.selectorConfidence}
        </span>
      </div>
      {summary.component ? (
        <div className="captured-ui-component-row">
          <span className={`captured-ui-component-kind ${summary.component.confidence}`}>
            {formatComponentKind(summary.component.kind)}
          </span>
          <span>{summary.component.intent}</span>
          <span>{summary.component.confidence} template confidence</span>
        </div>
      ) : null}
      <dl className="captured-ui-card-grid">
        <div>
          <dt>Element</dt>
          <dd>{`<${summary.tagName}> ${summary.elementLabel}`}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd title={summary.sourceUrl}>{source}</dd>
        </div>
        <div>
          <dt>Selector</dt>
          <dd title={summary.selector}>{summary.selector}</dd>
        </div>
        {summary.bounds ? (
          <div>
            <dt>Size</dt>
            <dd>{summary.bounds.width} x {summary.bounds.height}</dd>
          </div>
        ) : null}
        {styleLine ? (
          <div>
            <dt>Style</dt>
            <dd>{styleLine}</dd>
          </div>
        ) : null}
        {summary.semanticContext ? (
          <div>
            <dt>Context</dt>
            <dd>{summary.semanticContext}</dd>
          </div>
        ) : null}
        {summary.hitElement ? (
          <div>
            <dt>Hit</dt>
            <dd>{summary.hitElement}</dd>
          </div>
        ) : null}
        {summary.component?.templateHints.length ? (
          <div>
            <dt>Template</dt>
            <dd title={summary.component.templateHints.join(" · ")}>
              {summary.component.templateHints[0]}
            </dd>
          </div>
        ) : null}
        {summary.component?.limitations.length ? (
          <div>
            <dt>Note</dt>
            <dd title={summary.component.limitations.join(" · ")}>
              {summary.component.limitations[0]}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function formatComponentKind(kind: NonNullable<CapturedUiDisplaySummary["component"]>["kind"]): string {
  if (kind === "nav") {
    return "Navigation";
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatStyleLine(style: CapturedUiDisplaySummary["styleSummary"]): string | undefined {
  if (!style) {
    return undefined;
  }

  return [
    style.font,
    style.color,
    style.background ? `${style.background} bg` : undefined,
    style.radius ? `${style.radius} radius` : undefined,
    style.shadow ? "shadow" : undefined
  ].filter(Boolean).join(" · ") || undefined;
}

function formatSourceLine(summary: CapturedUiDisplaySummary): string {
  if (summary.sourceTitle && summary.sourceDomain) {
    return `${summary.sourceTitle} · ${summary.sourceDomain}`;
  }
  return summary.sourceTitle || summary.sourceDomain || summary.sourceUrl;
}
