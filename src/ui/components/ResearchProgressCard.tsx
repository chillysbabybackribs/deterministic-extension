import { Activity } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { RunProgressEvent } from "../../shared/protocol";

export type ResearchProgressCardProps = {
  events: RunProgressEvent[];
  open: boolean;
};

export function ResearchProgressCard({ events, open }: ResearchProgressCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const latest = events.at(-1);
  const counts = useMemo(() => ({
    completed: events.filter((event) => event.status === "completed").length,
    warning: events.filter((event) => event.level === "warning" || event.status === "partial").length
  }), [events]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !open) {
      return;
    }

    body.scrollTop = body.scrollHeight;
  }, [events.length, open]);

  return (
    <section className={open ? "research-progress-card open" : "research-progress-card"} aria-live="polite">
      <header className="research-progress-header">
        <div className="research-progress-title">
          <Activity size={14} />
          <span>Research</span>
        </div>
        <div className="research-progress-meta">
          {counts.completed ? <span>{counts.completed} done</span> : null}
          {counts.warning ? <span>{counts.warning} flagged</span> : null}
          {latest?.status ? <span className={`research-status-chip status-${latest.status}`}>{formatStatus(latest.status)}</span> : null}
        </div>
      </header>
      <div className="research-progress-body" ref={bodyRef}>
        {events.map((event, index) => (
          <article className={`research-progress-line level-${event.level}${index === events.length - 1 ? " current" : ""}`} key={event.id}>
            <span className={`research-dot status-${event.status ?? "running"}`} aria-hidden="true" />
            <div className="research-line-copy">
              <div className="research-line-top">
                <span className="research-line-label">{event.label}</span>
                <span className={`research-line-status status-${event.status ?? "running"}`}>{formatStatus(event.status ?? "running")}</span>
              </div>
              <div className="research-line-detail">{event.detail}</div>
              <div className="research-line-subrow">
                <time>{formatTime(event.timestamp)}</time>
                {event.url ? <span className="research-line-url">{event.url}</span> : null}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
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
