import type { ChatConversationSummary, ChatMessage } from "../../conversation/conversationTypes";
import type { EvidencePacket } from "../../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../../execution/executionTypes";
import type { AppSettings } from "../../settings/settingsStore";
import type { ProviderSettings } from "../../settings/providerSettings";
import type { RunProgressEvent } from "../../shared/protocol";
import { ActivityDrawer } from "./ActivityDrawer";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { Composer } from "./Composer";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { MessageList } from "./MessageList";
import { ResearchProgressCard } from "./ResearchProgressCard";
import type { ComponentTemplatePlan } from "../../tools/componentTemplatePlanner";

const ENABLE_GENERATED_COMPONENT_PREVIEW = false;

export type ChatWindowProps = {
  messages: ChatMessage[];
  settings: AppSettings;
  conversations: ChatConversationSummary[];
  activeConversationId?: string;
  chatHistoryOpen: boolean;
  busy: boolean;
  runState: "idle" | "running" | "paused" | "stopping";
  activity: ExecutionLogEntry[];
  evidence?: EvidencePacket;
  progressEvents: RunProgressEvent[];
  progressOpen: boolean;
  generatedPreviewPlan?: ComponentTemplatePlan;
  showEvidence: boolean;
  activityOpen: boolean;
  evidenceOpen: boolean;
  onCloseProgress: () => void;
  onCloseChatHistory: () => void;
  onCloseActivity: () => void;
  onCloseEvidence: () => void;
  onNewChat: () => void;
  onOpenProgress: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onPauseRun: () => void;
  onResumeRun: () => void;
  onSaveApiKeys: (keys: Pick<ProviderSettings, "apiKey" | "geminiApiKey" | "openaiApiKey">) => void | Promise<void>;
  onSend: (message: string) => void | Promise<void>;
  onStopRun: () => void;
  /** Opt-in companion ("background engine") state + handlers for the inline pill. */
  companion?: {
    connected: boolean;
    dismissedGapMessageIds: ReadonlySet<string>;
    onInstall: () => void;
    onDismissGap: (messageId: string) => void;
    onAsk: (question: string) => void;
  };
};

export function ChatWindow({
  messages,
  settings,
  conversations,
  activeConversationId,
  chatHistoryOpen,
  busy,
  runState,
  activity,
  evidence,
  progressEvents,
  progressOpen,
  generatedPreviewPlan,
  showEvidence,
  activityOpen,
  evidenceOpen,
  onCloseProgress,
  onCloseChatHistory,
  onCloseActivity,
  onCloseEvidence,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onPauseRun,
  onOpenProgress,
  onResumeRun,
  onSaveApiKeys,
  onSend,
  onStopRun,
  companion
}: ChatWindowProps) {
  const generatedPreviewVisible = ENABLE_GENERATED_COMPONENT_PREVIEW && Boolean(generatedPreviewPlan);

  function openProgress() {
    onCloseActivity();
    onCloseEvidence();
    onCloseChatHistory();
    onOpenProgress();
  }

  return (
    <section className={progressEvents.length ? "chat-window has-progress-tab" : "chat-window"}>
      <div className="chat-top-anchor">
        <ChatHistoryDrawer
          conversations={conversations}
          activeConversationId={activeConversationId}
          open={chatHistoryOpen}
          busy={busy}
          onNewChat={onNewChat}
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
        />
      </div>
      <MessageList
        messages={messages}
        busy={busy}
        hideCaptureSummaries={generatedPreviewVisible}
        providerSettings={settings.provider}
        onSaveApiKeys={onSaveApiKeys}
        companionConnected={companion?.connected}
        dismissedGapMessageIds={companion?.dismissedGapMessageIds}
        onInstallCompanion={companion?.onInstall}
        onDismissGap={companion?.onDismissGap}
        onAskCompanion={companion?.onAsk}
      />
      <div className="chat-bottom-anchor">
        <ResearchProgressCard
          events={progressEvents}
          open={progressOpen && progressEvents.length > 0}
          onClose={onCloseProgress}
          onOpen={openProgress}
        />
        <ActivityDrawer entries={activity} open={activityOpen} onClose={onCloseActivity} />
        {showEvidence ? (
          <EvidenceDrawer packet={evidence} open={evidenceOpen} onClose={onCloseEvidence} />
        ) : null}
        <Composer
          busy={busy}
          runState={runState}
          onNewChat={onNewChat}
          onPauseRun={onPauseRun}
          onResumeRun={onResumeRun}
          onSend={onSend}
          onStopRun={onStopRun}
        />
      </div>
    </section>
  );
}
