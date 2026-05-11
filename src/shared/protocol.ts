import type { ChatContextMessage } from "../conversation/conversationTypes";
import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import type { AppSettings } from "../settings/settingsStore";

export type RunRequest = {
  type: "ohmygod.run";
  message: string;
  settings: AppSettings;
  history?: ChatContextMessage[];
};

export type RunProgressLevel = "info" | "warning" | "error" | "debug";
export type RunProgressStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped";

export type RunProgressEvent = {
  id: string;
  timestamp: string;
  level: RunProgressLevel;
  label: string;
  detail: string;
  status?: RunProgressStatus;
  url?: string;
};

export type RunPortClientMessage = RunRequest;

export type RunPortServerMessage =
  | {
      type: "ohmygod.progress";
      event: RunProgressEvent;
    }
  | {
      type: "ohmygod.done";
      response: RunResponse;
    };

export type RunResponse = {
  ok: boolean;
  answer: string;
  activity: ExecutionLogEntry[];
  evidence?: EvidencePacket;
  error?: string;
};
