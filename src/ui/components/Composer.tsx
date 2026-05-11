import { Activity, Database, Send } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

export type ComposerProps = {
  busy: boolean;
  activityCount: number;
  activityOpen: boolean;
  evidenceCount: number;
  evidenceOpen: boolean;
  showEvidence: boolean;
  onToggleActivity: () => void;
  onToggleEvidence: () => void;
  onSend: (message: string) => void | Promise<void>;
};

export function Composer({
  busy,
  activityCount,
  activityOpen,
  evidenceCount,
  evidenceOpen,
  showEvidence,
  onToggleActivity,
  onToggleEvidence,
  onSend
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = value.trim();
    if (!message || busy) {
      return;
    }

    setValue("");
    scheduleTextareaFocus();
    await onSend(message);
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <div className="composer-tool-stack">
        {showEvidence ? (
          <button
            className={evidenceOpen ? "evidence-toggle-button active" : "evidence-toggle-button"}
            type="button"
            onClick={onToggleEvidence}
            title="Evidence"
            aria-label={`Evidence${evidenceCount ? ` (${evidenceCount})` : ""}`}
            aria-expanded={evidenceOpen}
            aria-controls="evidence-drawer"
          >
            <Database size={17} />
            {evidenceCount ? <span className="activity-toggle-count">{Math.min(evidenceCount, 99)}</span> : null}
          </button>
        ) : null}
        <button
          className={activityOpen ? "activity-toggle-button active" : "activity-toggle-button"}
          type="button"
          onClick={onToggleActivity}
          title="Activity"
          aria-label={`Activity${activityCount ? ` (${activityCount})` : ""}`}
          aria-expanded={activityOpen}
          aria-controls="activity-drawer"
        >
          <Activity size={17} />
          {activityCount ? <span className="activity-toggle-count">{Math.min(activityCount, 99)}</span> : null}
        </button>
      </div>
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
      <button className="send-button" type="submit" disabled={busy || !value.trim()} title="Send" aria-label="Send">
        <Send size={17} />
      </button>
    </form>
  );
}
