import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { RunProgressComparisonSubjectCoverage, RunProgressEvent } from "../../shared/protocol";

export type ResearchProgressCardProps = {
  events: RunProgressEvent[];
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
};

export function ResearchProgressCard({ events, open, onClose, onOpen }: ResearchProgressCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number>();
  const scrollSettleTimerRef = useRef<number>();
  const latest = events.at(-1);
  const coverage = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].coverage) {
        return events[index].coverage;
      }
    }
    return undefined;
  }, [events]);
  const comparisonSubjects = coverage?.comparisonSubjects ?? [];
  const panelTitle = progressPanelTitle(events);
  const counts = useMemo(() => {
    let completed = 0;
    let warning = 0;
    for (const event of events) {
      if (event.status === "completed") {
        completed += 1;
      }
      if (event.level === "warning" || event.status === "partial") {
        warning += 1;
      }
    }
    return { completed, total: events.length, warning };
  }, [events]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !open) {
      return;
    }

    if (scrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    if (scrollSettleTimerRef.current !== undefined) {
      window.clearTimeout(scrollSettleTimerRef.current);
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrollToBottom = (behavior: ScrollBehavior) => {
      body.scrollTo({
        top: body.scrollHeight,
        behavior
      });
    };

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      scrollToBottom(prefersReducedMotion ? "auto" : "smooth");
    });

    scrollSettleTimerRef.current = window.setTimeout(() => {
      scrollSettleTimerRef.current = undefined;
      scrollToBottom(prefersReducedMotion ? "auto" : "smooth");
    }, 190);
  }, [events.length, open]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (scrollSettleTimerRef.current !== undefined) {
        window.clearTimeout(scrollSettleTimerRef.current);
      }
    },
    []
  );

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
            <span>{panelTitle}</span>
          </div>
          <div className="research-progress-meta">
            {coverage ? <span className="research-coverage-summary">{formatCoverage(coverage)}</span> : null}
            {!coverage && counts.completed ? <span>{counts.completed} done</span> : null}
            {counts.warning ? <span>{counts.warning} flagged</span> : null}
            {latest?.status ? <span className={`research-status-chip status-${latest.status}`}>{formatStatus(latest.status)}</span> : null}
          </div>
        </header>
        {comparisonSubjects.length ? (
          <div className="research-subject-coverage" aria-label="Comparison subject coverage">
            {comparisonSubjects.map((subject) => (
              <span
                className={subject.authoritativeSource ? "research-subject-chip covered" : "research-subject-chip missing"}
                key={subject.name}
                title={`${subject.name}: ${formatSubjectCoverage(subject)}`}
              >
                <span className="research-subject-name">{subject.name}</span>
                <span className="research-subject-status">{formatSubjectCoverage(subject)}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="research-progress-body" ref={bodyRef}>
          {events.map((event, index) => {
            const status = event.status ?? "running";
            return (
              <article
                aria-label={`${formatProgressLabel(event.label)}. ${event.detail}`}
                className={`research-progress-line level-${event.level} status-${status}${index === events.length - 1 ? " current" : ""}`}
                key={event.id}
                tabIndex={0}
              >
                <span className={`research-dot status-${status}`} aria-hidden="true" />
                <div className="research-line-copy">
                  <div className="research-line-top">
                    <span className="research-line-title">
                      <span className="research-line-label">{formatProgressLabel(event.label)}</span>
                    </span>
                    <span className="research-line-badges">
                      {event.sourceQuality && event.sourceQuality !== "accepted" ? (
                        <span
                          aria-label={formatSourceQuality(event.sourceQuality)}
                          className={`research-quality-text quality-${event.sourceQuality}`}
                          title={formatSourceQuality(event.sourceQuality)}
                        >
                          {formatSourceQuality(event.sourceQuality)}
                        </span>
                      ) : null}
                      <span className={`research-line-status status-${status}`}>{formatStatus(status)}</span>
                    </span>
                  </div>
                  <div className="research-line-secondary">
                    <div className="research-line-detail">{event.detail}</div>
                    <div className="research-line-subrow">
                      <time>{formatTime(event.timestamp)}</time>
                      {formatProgressDiagnostics(event) ? <span>{formatProgressDiagnostics(event)}</span> : null}
                      {event.url ? <span className="research-line-url">{event.url}</span> : null}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <button
        aria-controls="research-progress-card"
        aria-expanded={open}
        aria-label={open ? "Collapse progress details" : "Review progress details"}
        className={open ? "research-progress-tab open" : "research-progress-tab"}
        onClick={open ? onClose : onOpen}
        title={open ? "Collapse progress details" : "Review progress details"}
        type="button"
      >
        <span className="research-progress-tab-title" aria-hidden="true">
          <Activity size={14} />
          <span>{panelTitle}</span>
        </span>
        <span className="research-progress-tab-icon">
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </span>
        <span className="research-progress-tab-meta">
          {coverage ? <span className="research-coverage-summary">{formatCoverage(coverage)}</span> : `${counts.total} ${counts.total === 1 ? "step" : "steps"}`}
        </span>
      </button>
    </>
  );
}

export function progressPanelTitle(events: RunProgressEvent[]): string {
  return events.some((event) => GENERAL_EXECUTION_LABELS.has(event.label.toLowerCase()))
    ? "Progress"
    : "Research";
}

const GENERAL_EXECUTION_LABELS = new Set([
  "browser action",
  "browser extract",
  "browser navigation",
  "browser observe",
  "browser search",
  "browser tool",
  "current page",
  "current page answer",
  "model answer",
  "model turn",
  "run failed",
  "run stopped",
  "unsupported capability"
]);

function formatStatus(status: NonNullable<RunProgressEvent["status"]>): string {
  return status.replace("_", " ");
}

function formatProgressLabel(label: string): string {
  switch (label) {
    case "Query":
      return "Preparing search";
    case "Google":
    case "Background Google search":
      return "Searching web";
    case "Prequalify":
      return "Checking sources";
    case "Browser check":
      return "Opening source";
    case "Warm":
      return "Loading page";
    case "Visit":
    case "Deep page":
      return "Visiting source";
    case "Scan":
      return "Reading page";
    case "Model answer":
      return "Writing answer";
    default:
      return label;
  }
}

function formatCoverage(coverage: NonNullable<RunProgressEvent["coverage"]>): string {
  const subjectCoverage = coverage.comparisonSubjects?.length
    ? ` · ${coverage.comparisonSubjects.filter((subject) => subject.authoritativeSource).length}/${coverage.comparisonSubjects.length} subjects`
    : "";
  return `${coverage.sources} ${pluralize("source", coverage.sources)} · ${coverage.domains} ${pluralize("domain", coverage.domains)} · ${coverage.passages} ${pluralize("passage", coverage.passages)}${subjectCoverage}`;
}

function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

function formatSourceQuality(quality: NonNullable<RunProgressEvent["sourceQuality"]>): string {
  switch (quality) {
    case "blocked":
      return "Blocked";
    case "thin":
      return "Thin";
    case "accepted":
      return "Accepted";
  }
}

function formatSubjectCoverage(subject: RunProgressComparisonSubjectCoverage): string {
  return subject.authoritativeSource ? "official found" : "official missing";
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

function formatProgressDiagnostics(event: RunProgressEvent): string {
  const parts = [
    typeof event.durationMs === "number" ? formatDuration(event.durationMs) : undefined,
    formatUsage(event.usage)
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

function formatDuration(durationMs: number): string {
  const safeDuration = Math.max(0, Math.round(durationMs));
  if (safeDuration < 1000) {
    return `${safeDuration}ms`;
  }

  const seconds = safeDuration / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

function formatUsage(usage: RunProgressEvent["usage"]): string | undefined {
  if (!usage) {
    return undefined;
  }

  const input = typeof usage.inputTokens === "number" ? `${usage.inputTokens.toLocaleString()} in` : undefined;
  const output = typeof usage.outputTokens === "number" ? `${usage.outputTokens.toLocaleString()} out` : undefined;
  return [input, output].filter(Boolean).join(" / ") || undefined;
}
