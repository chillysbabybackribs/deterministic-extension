import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { RunProgressEvent } from "../../shared/protocol";

export type ResearchProgressCardProps = {
  events: RunProgressEvent[];
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
};

export function ResearchProgressCard({ events, open, onClose, onOpen }: ResearchProgressCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const latest = events.at(-1);
  const counts = useMemo(() => ({
    completed: events.filter((event) => event.status === "completed").length,
    total: events.length,
    warning: events.filter((event) => event.level === "warning" || event.status === "partial").length
  }), [events]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !open) {
      return;
    }

    body.scrollTop = body.scrollHeight;
  }, [events.length, open]);

  if (!events.length) {
    return null;
  }

  return (
    <>
      <section
        aria-live="polite"
        className={open ? "research-progress-card open" : "research-progress-card"}
        id="research-progress-card"
      >
        <header className="research-progress-header">
          <div className="research-progress-title">
            <Activity size={14} />
            <span>Research</span>
          </div>
          <div className="research-progress-header-actions">
            <div className="research-progress-meta">
              {counts.completed ? <span>{counts.completed} done</span> : null}
              {counts.warning ? <span>{counts.warning} flagged</span> : null}
              {latest?.status ? <span className={`research-status-chip status-${latest.status}`}>{formatStatus(latest.status)}</span> : null}
            </div>
            <button
              aria-label="Collapse research details"
              className="research-progress-collapse-button"
              onClick={onClose}
              title="Collapse research details"
              type="button"
            >
              <ChevronDown size={15} />
            </button>
          </div>
        </header>
        <div className="research-progress-body" ref={bodyRef}>
          {events.map((event, index) => {
            const status = event.status ?? "running";
            return (
              <article className={`research-progress-line level-${event.level} status-${status}${index === events.length - 1 ? " current" : ""}`} key={event.id}>
                <span className={`research-dot status-${status}`} aria-hidden="true" />
                <div className="research-line-copy">
                  <div className="research-line-top">
                    <span className="research-line-label">{event.label}</span>
                    <span className={`research-line-status status-${status}`}>{formatStatus(status)}</span>
                  </div>
                  <div className="research-line-detail">{event.detail}</div>
                  <div className="research-line-subrow">
                    <time>{formatTime(event.timestamp)}</time>
                    {event.url ? <span className="research-line-url">{event.url}</span> : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      {!open ? (
        <button
          aria-controls="research-progress-card"
          aria-expanded={open}
          className="research-progress-tab"
          onClick={onOpen}
          title="Review research details"
          type="button"
        >
          <span className="research-progress-tab-title">
            <Activity size={13} />
            <span>Research</span>
          </span>
          <span className="research-progress-tab-meta">
            {counts.total} {counts.total === 1 ? "step" : "steps"}
            {latest?.status ? <span className={`research-status-chip status-${latest.status}`}>{formatStatus(latest.status)}</span> : null}
            <ChevronUp className="research-progress-tab-chevron" size={15} />
          </span>
        </button>
      ) : null}
    </>
  );
}

function formatStatus(status: NonNullable<RunProgressEvent["status"]>): string {
  return status.replace("_", " ");
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
