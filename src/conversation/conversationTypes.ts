import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import type { CapturedUiDisplaySummary } from "../tools/pageCapture";

/**
 * Capabilities the in-browser extension cannot perform alone, which an opt-in
 * local companion ("background engine") would unlock. Defined here (a leaf type
 * module) so both protocol.ts and the UI types can reference it without a cycle.
 */
export type CapabilityName = "full_network_capture" | "local_filesystem" | "local_process";

export type CapabilityGap = {
  capability: CapabilityName;
  /** Short, user-facing reason this task was limited (one sentence). */
  reason: string;
  /**
   * Prompt-specific explainer generated post-answer: why THIS task was limited
   * and what the engine would unlock for it. Shown in the pill's details. Absent
   * until the explainer step fills it; the pill falls back to `reason` + generic
   * copy when it's missing.
   */
  detail?: string;
};

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: "sending" | "complete" | "error";
  evidencePacket?: EvidencePacket;
  warnings?: string[];
  captureSummary?: CapturedUiDisplaySummary;
  /**
   * Set when this turn hit a capability an opt-in local companion could unlock.
   * Drives the inline opt-in pill on this message.
   */
  capabilityGap?: CapabilityGap;
};

export type ChatContextMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  activity: ExecutionLogEntry[];
  latestEvidence?: EvidencePacket;
};

export type ChatConversationSummary = Omit<ChatConversation, "messages" | "activity" | "latestEvidence"> & {
  messageCount: number;
};

export type ChatHistorySnapshot = {
  activeConversationId?: string;
  conversations: ChatConversation[];
};

export type ChatControllerSnapshot = {
  messages: ChatMessage[];
  latestEvidence?: EvidencePacket;
  busy: boolean;
};

export function createChatMessage(
  role: ChatRole,
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    status: "complete",
    ...extra
  };
}
