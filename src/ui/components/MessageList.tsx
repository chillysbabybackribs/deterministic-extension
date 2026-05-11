import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import type { ChatMessage } from "../../conversation/conversationTypes";
import { MarkdownMessage } from "./MarkdownMessage";

const BOTTOM_LOCK_THRESHOLD = 72;
const FOLLOW_UP_SCROLL_DELAYS = [40, 120, 280];
const USER_MESSAGE_PIN_OFFSET = 270;
const PIN_FROZEN_RESERVE_FRACTION = 0.4;

export type MessageListProps = {
  messages: ChatMessage[];
  busy: boolean;
};

export function MessageList({ messages, busy }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>();
  const timeoutRefs = useRef<number[]>([]);
  const shouldStickToBottomRef = useRef(true);
  const pinLatestUserMessageRef = useRef(false);
  const pinHasOverflowedRef = useRef(false);
  const previousMessageCountRef = useRef(messages.length);

  const messageFingerprint = useMemo(
    () =>
      messages
        .map((message) => `${message.id}:${message.content.length}:${message.warnings?.length ?? 0}`)
        .join("|"),
    [messages]
  );
  const lastMessageRole = messages.at(-1)?.role;
  const showThinking = busy && lastMessageRole === "user";

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

  function handleScroll() {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= BOTTOM_LOCK_THRESHOLD;
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
    <div className="message-list" aria-live="polite" onScroll={handleScroll} ref={listRef}>
      {messages.map((message) => (
        <article className={`message ${message.role} ${message.status ?? "complete"}`} key={message.id}>
          <div className="message-content">
            {message.role === "assistant" ? (
              <MarkdownMessage content={message.content} />
            ) : (
              message.content
            )}
          </div>
          {message.warnings?.length ? (
            <ul className="message-warnings">
              {message.warnings.slice(0, 3).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
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
