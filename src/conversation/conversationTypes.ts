import type { EvidencePacket } from "../evidence/evidenceTypes";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: "sending" | "complete" | "error";
  evidencePacket?: EvidencePacket;
  warnings?: string[];
};

export type ChatContextMessage = {
  role: "user" | "assistant";
  content: string;
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
