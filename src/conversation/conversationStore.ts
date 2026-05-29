import type {
  ChatConversation,
  ChatHistorySnapshot,
  ChatMessage,
  ChatRole
} from "./conversationTypes";
import type {
  CapturedUiDisplaySummary,
  CapturedUiComponentIntent,
  CapturedUiComponentKind,
  CapturedUiSelectorConfidence
} from "../tools/pageCapture";
import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";

const CHAT_HISTORY_KEY = "ohmygod.chatHistory.v2";
const LEGACY_CHAT_HISTORY_KEY = "ohmygod.chatHistory.v1";
const CHAT_HISTORY_VERSION = 2;
const LEGACY_CHAT_HISTORY_VERSION = 1;
const MAX_STORED_CONVERSATIONS = 40;
const MAX_STORED_MESSAGES = 80;
const MAX_STORED_ACTIVITY_ENTRIES = 160;
const MAX_STORED_MESSAGE_CHARS = 24000;
const MAX_STORED_WARNINGS = 5;
const MAX_STORED_EVIDENCE_STRING_CHARS = 8000;
const MAX_STORED_EVIDENCE_ARRAY_ITEMS = 80;
const MAX_STORED_EVIDENCE_DEPTH = 8;

type StoredChatHistory = {
  version: typeof CHAT_HISTORY_VERSION;
  updatedAt: string;
  activeConversationId?: string;
  conversations: StoredChatConversation[];
};

type StoredLegacyChatHistory = {
  version: typeof LEGACY_CHAT_HISTORY_VERSION;
  updatedAt: string;
  messages: StoredChatMessage[];
};

type StoredChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
  activity: ExecutionLogEntry[];
  latestEvidence?: EvidencePacket;
};

type StoredChatMessage = Omit<ChatMessage, "evidencePacket">;

export async function loadChatHistory(): Promise<ChatHistorySnapshot> {
  const stored = await readStorageValue(CHAT_HISTORY_KEY);
  const normalized = normalizeStoredHistory(stored);
  if (normalized.conversations.length || isVersionedHistory(stored, CHAT_HISTORY_VERSION)) {
    return normalized;
  }

  const legacy = await readStorageValue(LEGACY_CHAT_HISTORY_KEY);
  return normalizeLegacyStoredHistory(legacy);
}

export async function saveChatHistory(snapshot: ChatHistorySnapshot): Promise<void> {
  const history = toStoredHistory(snapshot);

  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: history });
    return;
  }

  getLocalStorage()?.setItem(CHAT_HISTORY_KEY, JSON.stringify(history));
}

export async function clearChatHistory(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove([CHAT_HISTORY_KEY, LEGACY_CHAT_HISTORY_KEY]);
    return;
  }

  const storage = getLocalStorage();
  storage?.removeItem(CHAT_HISTORY_KEY);
  storage?.removeItem(LEGACY_CHAT_HISTORY_KEY);
}

export function createConversationId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toStoredHistory(snapshot: ChatHistorySnapshot): StoredChatHistory {
  const conversations = snapshot.conversations
    .map(toStoredConversation)
    .filter((conversation): conversation is StoredChatConversation => Boolean(conversation))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_CONVERSATIONS);
  const activeConversationId = conversations.some((conversation) => conversation.id === snapshot.activeConversationId)
    ? snapshot.activeConversationId
    : conversations[0]?.id;

  return omitUndefined({
    version: CHAT_HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    activeConversationId,
    conversations
  });
}

function toStoredConversation(conversation: ChatConversation): StoredChatConversation | undefined {
  const messages = conversation.messages
    .slice(-MAX_STORED_MESSAGES)
    .map(toStoredMessage)
    .filter((message) => message.content.trim());

  if (!messages.length) {
    return undefined;
  }

  const storedConversation: StoredChatConversation = {
    id: conversation.id || createConversationId(),
    title: clipText(conversation.title.trim() || "New chat", 80),
    createdAt: normalizeDate(conversation.createdAt) ?? messages[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: normalizeDate(conversation.updatedAt) ?? messages.at(-1)?.createdAt ?? new Date().toISOString(),
    messages,
    activity: toStoredActivity(conversation.activity)
  };
  const latestEvidence = toStoredEvidence(conversation.latestEvidence);

  if (latestEvidence) {
    storedConversation.latestEvidence = latestEvidence;
  }

  return storedConversation;
}

function toStoredMessage(message: ChatMessage): StoredChatMessage {
  const storedMessage: StoredChatMessage = {
    id: message.id,
    role: message.role,
    content: clipText(message.content, MAX_STORED_MESSAGE_CHARS),
    createdAt: message.createdAt,
    status: message.status === "error" ? "error" : "complete"
  };
  const warnings = normalizeWarnings(message.warnings);

  if (warnings) {
    storedMessage.warnings = warnings;
  }
  const captureSummary = normalizeCaptureSummary(message.captureSummary);

  if (captureSummary) {
    storedMessage.captureSummary = captureSummary;
  }

  return storedMessage;
}

async function readStorageValue(key: string): Promise<unknown> {
  if (hasChromeStorage()) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (stored) => {
        resolve(stored[key]);
      });
    });
  }

  const raw = getLocalStorage()?.getItem(key);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeStoredHistory(value: unknown): ChatHistorySnapshot {
  if (!isRecord(value) || value.version !== CHAT_HISTORY_VERSION || !Array.isArray(value.conversations)) {
    return { conversations: [] };
  }

  const conversations = value.conversations
    .map(normalizeStoredConversation)
    .filter((conversation): conversation is ChatConversation => Boolean(conversation))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_CONVERSATIONS);
  const activeConversationId =
    typeof value.activeConversationId === "string" &&
    conversations.some((conversation) => conversation.id === value.activeConversationId)
      ? value.activeConversationId
      : conversations[0]?.id;

  return omitUndefined({
    activeConversationId,
    conversations
  });
}

function normalizeLegacyStoredHistory(value: unknown): ChatHistorySnapshot {
  if (!isRecord(value) || value.version !== LEGACY_CHAT_HISTORY_VERSION || !Array.isArray(value.messages)) {
    return { conversations: [] };
  }

  const legacyHistory = normalizeLegacyMessages(value);
  if (!legacyHistory.messages.length) {
    return { conversations: [] };
  }

  const conversation: ChatConversation = {
    id: createConversationId(),
    title: createTitle(legacyHistory.messages),
    createdAt: legacyHistory.messages[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: normalizeDate(value.updatedAt) ?? legacyHistory.messages.at(-1)?.createdAt ?? new Date().toISOString(),
    messages: legacyHistory.messages,
    activity: []
  };

  return {
    activeConversationId: conversation.id,
    conversations: [conversation]
  };
}

function normalizeLegacyMessages(value: unknown): StoredLegacyChatHistory {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return createEmptyLegacyHistory();
  }

  return {
    version: LEGACY_CHAT_HISTORY_VERSION,
    updatedAt: normalizeDate(value.updatedAt) ?? new Date().toISOString(),
    messages: value.messages
      .map(normalizeStoredMessage)
      .filter((message): message is StoredChatMessage => Boolean(message))
      .slice(-MAX_STORED_MESSAGES)
  };
}

function normalizeStoredConversation(value: unknown): ChatConversation | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return undefined;
  }

  const messages = value.messages
    .map(normalizeStoredMessage)
    .filter((message): message is StoredChatMessage => Boolean(message))
    .slice(-MAX_STORED_MESSAGES);

  if (!messages.length) {
    return undefined;
  }

  const conversation: ChatConversation = {
    id: typeof value.id === "string" && value.id ? value.id : createConversationId(),
    title: typeof value.title === "string" && value.title.trim() ? clipText(value.title.trim(), 80) : createTitle(messages),
    createdAt: normalizeDate(value.createdAt) ?? messages[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: normalizeDate(value.updatedAt) ?? messages.at(-1)?.createdAt ?? new Date().toISOString(),
    messages,
    activity: normalizeStoredActivity(value.activity)
  };
  const latestEvidence = normalizeStoredEvidence(value.latestEvidence);

  if (latestEvidence) {
    conversation.latestEvidence = latestEvidence;
  }

  return conversation;
}

function normalizeStoredMessage(value: unknown): StoredChatMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const role = normalizeRole(value.role);
  const content = typeof value.content === "string" ? clipText(value.content, MAX_STORED_MESSAGE_CHARS) : "";
  if (!role || !content.trim()) {
    return undefined;
  }

  const storedMessage: StoredChatMessage = {
    id: typeof value.id === "string" && value.id ? value.id : createStoredMessageId(),
    role,
    content,
    createdAt: normalizeDate(value.createdAt) ?? new Date().toISOString(),
    status: value.status === "error" ? "error" : "complete"
  };
  const warnings = normalizeWarnings(value.warnings);

  if (warnings) {
    storedMessage.warnings = warnings;
  }
  const captureSummary = normalizeCaptureSummary(value.captureSummary);

  if (captureSummary) {
    storedMessage.captureSummary = captureSummary;
  }

  return storedMessage;
}

function normalizeCaptureSummary(value: unknown): CapturedUiDisplaySummary | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.elementLabel !== "string") {
    return undefined;
  }

  const selectorConfidence: CapturedUiSelectorConfidence = value.selectorConfidence === "high" || value.selectorConfidence === "medium" || value.selectorConfidence === "low"
    ? value.selectorConfidence
    : "low";
  const bounds = isRecord(value.bounds) && typeof value.bounds.width === "number" && typeof value.bounds.height === "number"
    ? {
        width: Math.round(value.bounds.width),
        height: Math.round(value.bounds.height)
      }
    : undefined;
  const styleSummary = normalizeCaptureStyleSummary(value.styleSummary);

  return omitUndefined({
    title: clipText(value.title, 80),
    subtitle: typeof value.subtitle === "string" ? clipText(value.subtitle, 180) : "",
    sourceTitle: typeof value.sourceTitle === "string" ? clipText(value.sourceTitle, 180) : "",
    sourceUrl: typeof value.sourceUrl === "string" ? clipText(value.sourceUrl, 500) : "",
    sourceDomain: typeof value.sourceDomain === "string" ? clipText(value.sourceDomain, 120) : "",
    elementLabel: clipText(value.elementLabel, 180),
    elementDescription: typeof value.elementDescription === "string" ? clipText(value.elementDescription, 220) : clipText(value.elementLabel, 180),
    selector: typeof value.selector === "string" ? clipText(value.selector, 500) : "",
    selectorConfidence,
    tagName: typeof value.tagName === "string" ? clipText(value.tagName, 40) : "element",
    role: typeof value.role === "string" ? clipText(value.role, 80) : undefined,
    bounds,
    styleSummary,
    semanticContext: typeof value.semanticContext === "string" ? clipText(value.semanticContext, 220) : undefined,
    hitElement: typeof value.hitElement === "string" ? clipText(value.hitElement, 220) : undefined,
    component: normalizeCaptureComponentSummary(value.component)
  });
}

function normalizeCaptureComponentSummary(value: unknown): CapturedUiDisplaySummary["component"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeComponentKind(value.kind);
  const intent = normalizeComponentIntent(value.intent);
  const confidence = value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"
    ? value.confidence
    : "low";
  if (!kind || !intent) {
    return undefined;
  }

  return {
    kind,
    intent,
    confidence,
    templateHints: normalizeStringArray(value.templateHints, 3, 120),
    limitations: normalizeStringArray(value.limitations, 3, 140)
  };
}

function normalizeComponentKind(value: unknown): CapturedUiComponentKind | undefined {
  return value === "button" ||
    value === "link" ||
    value === "input" ||
    value === "image" ||
    value === "icon" ||
    value === "text" ||
    value === "nav" ||
    value === "form" ||
    value === "card" ||
    value === "section" ||
    value === "media" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeComponentIntent(value: unknown): CapturedUiComponentIntent | undefined {
  return value === "action" ||
    value === "navigation" ||
    value === "input" ||
    value === "content" ||
    value === "layout" ||
    value === "media" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeCaptureStyleSummary(value: unknown): CapturedUiDisplaySummary["styleSummary"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const style = omitUndefined({
    font: typeof value.font === "string" ? clipText(value.font, 160) : undefined,
    color: typeof value.color === "string" ? clipText(value.color, 80) : undefined,
    background: typeof value.background === "string" ? clipText(value.background, 80) : undefined,
    radius: typeof value.radius === "string" ? clipText(value.radius, 80) : undefined,
    shadow: typeof value.shadow === "string" ? clipText(value.shadow, 180) : undefined
  });

  return Object.keys(style).length ? style : undefined;
}

function normalizeStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => clipText(item.trim(), maxChars))
    .slice(0, maxItems);
}

function createTitle(messages: StoredChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? messages[0]?.content ?? "New chat";
  const title = firstUserMessage.replace(/\s+/g, " ").trim();
  return clipText(title || "New chat", 56);
}

function normalizeRole(value: unknown): ChatRole | undefined {
  return value === "user" || value === "assistant" || value === "system" ? value : undefined;
}

function toStoredActivity(entries: ExecutionLogEntry[] | undefined): ExecutionLogEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .slice(-MAX_STORED_ACTIVITY_ENTRIES)
    .map(normalizeStoredActivityEntry)
    .filter((entry): entry is ExecutionLogEntry => Boolean(entry));
}

function normalizeStoredActivity(value: unknown): ExecutionLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeStoredActivityEntry)
    .filter((entry): entry is ExecutionLogEntry => Boolean(entry))
    .slice(-MAX_STORED_ACTIVITY_ENTRIES);
}

function normalizeStoredActivityEntry(value: unknown): ExecutionLogEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string" || typeof value.label !== "string") {
    return undefined;
  }

  return omitUndefined({
    id: value.id,
    timestamp: normalizeDate(value.timestamp) ?? new Date().toISOString(),
    level: normalizeExecutionLevel(value.level),
    label: clipText(value.label, 240),
    details: typeof value.details === "string" ? clipText(value.details, 1200) : undefined,
    toolName: typeof value.toolName === "string" ? clipText(value.toolName, 120) : undefined,
    actionLabel: typeof value.actionLabel === "string" ? clipText(value.actionLabel, 240) : undefined,
    status: normalizeExecutionStatus(value.status),
    eventType: normalizeExecutionEventType(value.eventType),
    resultSummary: typeof value.resultSummary === "string" ? clipText(value.resultSummary, 1200) : undefined,
    warning: typeof value.warning === "string" ? clipText(value.warning, 1200) : undefined,
    startedAt: normalizeDate(value.startedAt),
    endedAt: normalizeDate(value.endedAt),
    durationMs: normalizeNonNegativeInteger(value.durationMs),
    usage: normalizeExecutionUsage(value.usage)
  });
}

function normalizeExecutionLevel(value: unknown): ExecutionLogEntry["level"] {
  return value === "warning" || value === "error" || value === "debug" ? value : "info";
}

function normalizeExecutionStatus(value: unknown): ExecutionLogEntry["status"] | undefined {
  return value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "skipped"
    ? value
    : undefined;
}

function normalizeExecutionEventType(value: unknown): ExecutionLogEntry["eventType"] | undefined {
  return value === "tab_read" ||
    value === "tab_navigate" ||
    value === "history_action" ||
    value === "reload" ||
    value === "failure" ||
    value === "tool"
    ? value
    : undefined;
}

function normalizeExecutionUsage(value: unknown): ExecutionLogEntry["usage"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage = omitUndefined({
    inputTokens: normalizeNonNegativeInteger(value.inputTokens),
    outputTokens: normalizeNonNegativeInteger(value.outputTokens),
    totalTokens: normalizeNonNegativeInteger(value.totalTokens)
  });

  return Object.keys(usage).length ? usage : undefined;
}

function toStoredEvidence(packet: EvidencePacket | undefined): EvidencePacket | undefined {
  if (!packet) {
    return undefined;
  }

  return sanitizeStoredValue(packet) as EvidencePacket;
}

function normalizeStoredEvidence(value: unknown): EvidencePacket | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.quality !== "string") {
    return undefined;
  }

  return sanitizeStoredValue(value) as EvidencePacket;
}

function sanitizeStoredValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return clipText(value, MAX_STORED_EVIDENCE_STRING_CHARS);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_STORED_EVIDENCE_DEPTH) {
      return [];
    }

    return value
      .slice(0, MAX_STORED_EVIDENCE_ARRAY_ITEMS)
      .map((item) => sanitizeStoredValue(item, depth + 1));
  }

  if (isRecord(value)) {
    if (depth >= MAX_STORED_EVIDENCE_DEPTH) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
        .map(([key, entry]) => [key, sanitizeStoredValue(entry, depth + 1)])
    );
  }

  return undefined;
}

function isVersionedHistory(value: unknown, version: number): boolean {
  return isRecord(value) && value.version === version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeWarnings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const warnings = value
    .filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
    .map((warning) => clipText(warning, 500))
    .slice(0, MAX_STORED_WARNINGS);

  return warnings.length ? warnings : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return undefined;
  }

  return value;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.round(value);
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function createEmptyLegacyHistory(): StoredLegacyChatHistory {
  return {
    version: LEGACY_CHAT_HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    messages: []
  };
}

function createStoredMessageId(): string {
  return `stored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

type LocalStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function getLocalStorage(): LocalStorageLike | undefined {
  const candidate = globalThis as typeof globalThis & {
    localStorage?: LocalStorageLike;
  };

  return candidate.localStorage;
}
