import { Pause, Play, Plus, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

export type ComposerProps = {
  busy: boolean;
  runState: "idle" | "running" | "paused" | "stopping";
  onNewChat: () => void;
  onPauseRun: () => void;
  onResumeRun: () => void;
  onSend: (message: string) => void | Promise<void>;
  onStopRun: () => void;
};

export function Composer({
  busy,
  runState,
  onNewChat,
  onPauseRun,
  onResumeRun,
  onSend,
  onStopRun
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusFrameRef = useRef<number>();

  const focusTextarea = useCallback(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const scheduleTextareaFocus = useCallback(() => {
    focusTextarea();

    if (focusFrameRef.current !== undefined) {
      window.cancelAnimationFrame(focusFrameRef.current);
    }

    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = undefined;
      focusTextarea();
    });
  }, [focusTextarea]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== undefined) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    []
  );

  const sendCurrentMessage = useCallback(async () => {
    const message = value.trim();
    if (!message || busy) {
      return;
    }

    setValue("");
    scheduleTextareaFocus();
    await onSend(message);
  }, [busy, onSend, scheduleTextareaFocus, value]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendCurrentMessage();
  }

  return (
    <form className={busy ? "composer is-busy" : "composer"} onSubmit={handleSubmit}>
      <div className="composer-input-shell">
        <textarea
          ref={textareaRef}
          value={value}
          placeholder="Message the assistant"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-inline-actions">
          <button
            className="composer-new-chat-button"
            type="button"
            disabled={busy}
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
          >
            <Plus size={17} />
          </button>
          {busy ? (
            <div className="run-control-stack">
              <button
                className="run-control-button"
                type="button"
                disabled={runState === "stopping"}
                onClick={runState === "paused" ? onResumeRun : onPauseRun}
                title={runState === "paused" ? "Resume" : "Pause"}
                aria-label={runState === "paused" ? "Resume run" : "Pause run"}
              >
                {runState === "paused" ? <Play size={16} /> : <Pause size={16} />}
              </button>
              <button
                className="run-stop-button"
                type="button"
                disabled={runState === "stopping"}
                onClick={onStopRun}
                title="Stop"
                aria-label="Stop run"
              >
                <Square size={15} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}
