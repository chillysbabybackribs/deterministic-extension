import { AlertTriangle, CheckCircle2, Clock3, Info, LoaderCircle, XCircle } from "lucide-react";
import type { BrowserExecutionStatus, ExecutionLogEntry } from "../../execution/executionTypes";

export type ToolStatusProps = {
  entry: ExecutionLogEntry;
};

export function ToolStatus({ entry }: ToolStatusProps) {
  const status = entry.status ?? statusFromLevel(entry.level);
  const Icon = iconForStatus(status, entry.level);
  const summary = entry.resultSummary ?? entry.details;
  const warning = entry.warning && entry.warning !== summary ? entry.warning : undefined;

  return (
    <div className={`activity-item status-${status}`}>
      <div className="activity-topline">
        <div className={`activity-tool level-${entry.level}`}>
          <Icon size={14} />
          <span>{entry.toolName ?? "Browser"}</span>
        </div>
        <span className={`activity-status-pill status-${status}`}>{formatStatus(status)}</span>
      </div>
      <div className="activity-action">{entry.actionLabel ?? entry.label}</div>
      {summary ? <div className="activity-details">{summary}</div> : null}
      {warning ? <div className="activity-warning">{warning}</div> : null}
      <div className="activity-time">{formatTime(entry.timestamp)}</div>
    </div>
  );
}

function statusFromLevel(level: ExecutionLogEntry["level"]): BrowserExecutionStatus {
  if (level === "error") {
    return "failed";
  }

  if (level === "warning") {
    return "partial";
  }

  return "completed";
}

function iconForStatus(status: BrowserExecutionStatus, level: ExecutionLogEntry["level"]) {
  if (status === "failed") {
    return XCircle;
  }

  if (status === "partial" || level === "warning") {
    return AlertTriangle;
  }

  if (status === "starting") {
    return Clock3;
  }

  if (status === "running") {
    return LoaderCircle;
  }

  if (level === "debug") {
    return Info;
  }

  return CheckCircle2;
}

function formatStatus(status: BrowserExecutionStatus): string {
  if (status === "partial") {
    return "Partial";
  }

  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
