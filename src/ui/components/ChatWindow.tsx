import { useState } from "react";
import type { ChatMessage } from "../../conversation/conversationTypes";
import type { EvidencePacket } from "../../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../../execution/executionTypes";
import type { RunProgressEvent } from "../../shared/protocol";
import { ActivityDrawer } from "./ActivityDrawer";
import { Composer } from "./Composer";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { MessageList } from "./MessageList";
import { ResearchProgressCard } from "./ResearchProgressCard";

export type ChatWindowProps = {
  messages: ChatMessage[];
  busy: boolean;
  activity: ExecutionLogEntry[];
  evidence?: EvidencePacket;
  progressEvents: RunProgressEvent[];
  progressOpen: boolean;
  showEvidence: boolean;
  onSend: (message: string) => void | Promise<void>;
};

export function ChatWindow({
  messages,
  busy,
  activity,
  evidence,
  progressEvents,
  progressOpen,
  showEvidence,
  onSend
}: ChatWindowProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  function toggleActivity() {
    setActivityOpen((open) => !open);
    setEvidenceOpen(false);
  }

  function toggleEvidence() {
    setEvidenceOpen((open) => !open);
    setActivityOpen(false);
  }

  return (
    <section className="chat-window">
      <MessageList messages={messages} busy={busy} />
      <div className="chat-bottom-anchor">
        <ResearchProgressCard events={progressEvents} open={progressOpen && progressEvents.length > 0} />
        <ActivityDrawer entries={activity} open={activityOpen} onClose={() => setActivityOpen(false)} />
        {showEvidence ? (
          <EvidenceDrawer packet={evidence} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />
        ) : null}
        <Composer
          busy={busy}
          activityCount={activity.length}
          activityOpen={activityOpen}
          evidenceCount={evidence?.items.length ?? 0}
          evidenceOpen={evidenceOpen}
          showEvidence={showEvidence}
          onToggleActivity={toggleActivity}
          onToggleEvidence={toggleEvidence}
          onSend={onSend}
        />
      </div>
    </section>
  );
}
