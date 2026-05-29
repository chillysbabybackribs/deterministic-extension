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
  const label = formatActivityLabel(entry.actionLabel ?? entry.label);
  const toolName = formatActivityLabel(entry.toolName ?? "Browser");
  const diagnostics = formatActivityDiagnostics(entry);

  return (
    <div className={`activity-item status-${status}`}>
      <div className="activity-topline">
        <div className={`activity-tool level-${entry.level}`}>
          <Icon size={14} />
          <span>{toolName}</span>
        </div>
        <span className={`activity-status-pill status-${status}`}>{formatStatus(status)}</span>
      </div>
      <div className="activity-action">{label}</div>
      {summary ? <div className="activity-details">{summary}</div> : null}
      {warning ? <div className="activity-warning">{warning}</div> : null}
      <div className="activity-meta">
        <span>{formatTime(entry.timestamp)}</span>
        {diagnostics ? <span>{diagnostics}</span> : null}
      </div>
    </div>
  );
}

function formatActivityLabel(label: string): string {
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

export function formatActivityDiagnostics(entry: ExecutionLogEntry): string {
  const parts = [
    typeof entry.durationMs === "number" ? formatDuration(entry.durationMs) : undefined,
    formatUsage(entry.usage)
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

function formatUsage(usage: ExecutionLogEntry["usage"]): string | undefined {
  if (!usage) {
    return undefined;
  }

  const input = typeof usage.inputTokens === "number" ? `${formatCount(usage.inputTokens)} in` : undefined;
  const output = typeof usage.outputTokens === "number" ? `${formatCount(usage.outputTokens)} out` : undefined;
  if (input || output) {
    return [input, output].filter(Boolean).join(" / ");
  }

  return typeof usage.totalTokens === "number" ? `${formatCount(usage.totalTokens)} tokens` : undefined;
}

function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}
