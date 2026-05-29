import type { CapabilityGap, ChatContextMessage } from "../conversation/conversationTypes";
import type { ActiveWorkingFileDescriptor } from "../filecorpus/corpusTypes";
import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import type { AppSettings } from "../settings/settingsStore";
import type { BrowserToolCall, BrowserToolExecution } from "../tools/browserToolExecutor";

export type RunRequest = {
  type: "ohmygod.run";
  message: string;
  settings: AppSettings;
  history?: ChatContextMessage[];
  activeCaptureContext?: string;
  /** Descriptor of the attached working file (corpus stays in panel IndexedDB). */
  activeWorkingFile?: ActiveWorkingFileDescriptor;
};

export type RunControlAction = "pause" | "resume" | "stop";

export type RunControlRequest = {
  type: "ohmygod.control";
  action: RunControlAction;
};

export type RunProgressLevel = "info" | "warning" | "error" | "debug";
export type RunProgressStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "paused"
  | "stopped";

export type RunProgressSourceKind =
  | "article"
  | "blog"
  | "code"
  | "community"
  | "docs"
  | "generic"
  | "github"
  | "news"
  | "official"
  | "research"
  | "video";

export type RunProgressSourceQuality =
  | "accepted"
  | "blocked"
  | "thin";

export type RunProgressCoverage = {
  status: "sufficient" | "insufficient" | "exhausted";
  score: number;
  sources: number;
  domains: number;
  passages: number;
  comparisonSubjects?: RunProgressComparisonSubjectCoverage[];
  coverageSlots?: RunProgressCoverageSlot[];
};

export type RunProgressComparisonSubjectCoverage = {
  name: string;
  authoritativeSource: boolean;
};

export type RunProgressCoverageSlot = {
  label: string;
  covered: boolean;
  required: boolean;
};

export type RunProgressUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RunProgressEvent = {
  id: string;
  timestamp: string;
  level: RunProgressLevel;
  label: string;
  detail: string;
  status?: RunProgressStatus;
  url?: string;
  sourceKind?: RunProgressSourceKind;
  sourceQuality?: RunProgressSourceQuality;
  coverage?: RunProgressCoverage;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  usage?: RunProgressUsage;
};

export type RunPortClientMessage = RunRequest | RunControlRequest;

export type RunPortServerMessage =
  | {
      type: "ohmygod.progress";
      event: RunProgressEvent;
    }
  | {
      type: "ohmygod.keepalive";
      timestamp: string;
    }
  | {
      type: "ohmygod.answer_delta";
      delta: string;
    }
  | {
      type: "ohmygod.done";
      response: RunResponse;
    }
  | {
      type: "ohmygod.workspace_tool_request";
      requestId: string;
      call: BrowserToolCall;
    };

// CapabilityName / CapabilityGap live in conversationTypes (a leaf module) to
// avoid a protocol<->conversationTypes import cycle; re-export for convenience.
export type { CapabilityName, CapabilityGap } from "../conversation/conversationTypes";

export type RunResponse = {
  ok: boolean;
  answer: string;
  activity: ExecutionLogEntry[];
  evidence?: EvidencePacket;
  /**
   * Set when a step in this turn hit a capability the local companion could
   * unlock. Drives the opt-in pill. Absent on a fully-satisfied turn.
   */
  capabilityGap?: CapabilityGap;
  error?: string;
};

export type WorkspaceToolResponse = {
  type: "ohmygod.workspace_tool_response";
  requestId: string;
  execution?: BrowserToolExecution;
  error?: string;
};
