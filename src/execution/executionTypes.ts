export type VisibleBrowserActionKind =
  | "active_tab"
  | "open_tab"
  | "navigate"
  | "reload"
  | "history"
  | "snapshot"
  | "source_lookup"
  | "web_search"
  | "extract"
  | "group_tabs"
  | "prune_tabs"
  | "scroll_scan";

export type BrowserExecutionEventType =
  | "tab_read"
  | "tab_navigate"
  | "history_action"
  | "reload"
  | "failure"
  | "tool";

export type BrowserExecutionStatus =
  | "starting"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped";

export type VisibleBrowserAction = {
  id: string;
  kind: VisibleBrowserActionKind;
  eventType: BrowserExecutionEventType;
  label: string;
  status: BrowserExecutionStatus;
  visible: boolean;
  startedAt: string;
  endedAt?: string;
  resultSummary?: string;
  warning?: string;
  metadata?: Record<string, unknown>;
};

export type ExecutionLogLevel = "info" | "warning" | "error" | "debug";

export type ExecutionLogEntry = {
  id: string;
  timestamp: string;
  level: ExecutionLogLevel;
  label: string;
  details?: string;
  toolName?: string;
  actionLabel?: string;
  status?: BrowserExecutionStatus;
  eventType?: BrowserExecutionEventType;
  resultSummary?: string;
  warning?: string;
};

export type ToolExecutionStatus = "success" | "partial" | "failed" | "skipped";

export type ToolExecutionResult<TOutput = unknown> = {
  callId: string;
  toolName: string;
  status: ToolExecutionStatus;
  output?: TOutput;
  error?: string;
  warnings: string[];
  visibleActions: VisibleBrowserAction[];
  startedAt: string;
  endedAt: string;
};

export type UniversalStepStatus =
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "stubbed"
  | "unavailable";

export type UniversalStepResult<TOutput = unknown> = {
  stepId: string;
  capability: string;
  status: UniversalStepStatus;
  startedAt: string;
  completedAt: string;
  input: Record<string, unknown>;
  output?: TOutput;
  warnings: string[];
  errors: string[];
  visibleActionPerformed: boolean;
  evidenceProduced: boolean;
  summary: string;
  toolName?: string;
  toolResult?: ToolExecutionResult<TOutput>;
};
