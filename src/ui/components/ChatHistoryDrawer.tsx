import { Plus, Trash2 } from "lucide-react";
import type { ChatConversationSummary } from "../../conversation/conversationTypes";

export type ChatHistoryDrawerProps = {
  conversations: ChatConversationSummary[];
  activeConversationId?: string;
  open: boolean;
  busy: boolean;
  onNewChat: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
};

export function ChatHistoryDrawer({
  conversations,
  activeConversationId,
  open,
  busy,
  onNewChat,
  onSelectConversation,
  onDeleteConversation
}: ChatHistoryDrawerProps) {
  return (
    <section
      id="chat-history-drawer"
      className={open ? "chat-history-drawer open" : "chat-history-drawer"}
      aria-label="Chat history"
      aria-hidden={!open}
    >
      <header className="chat-history-drawer-header">
        <span>Chat history</span>
        <button
          className="chat-history-icon-button"
          type="button"
          onClick={onNewChat}
          disabled={busy}
          tabIndex={open ? 0 : -1}
          title="New chat"
          aria-label="New chat"
        >
          <Plus size={16} />
        </button>
      </header>
      <div className="chat-history-list">
        {conversations.length ? (
          conversations.map((conversation) => (
            <div
              className={conversation.id === activeConversationId ? "chat-history-row active" : "chat-history-row"}
              key={conversation.id}
            >
              <button
                className="chat-history-row-button"
                type="button"
                onClick={() => onSelectConversation(conversation.id)}
                disabled={busy}
                tabIndex={open ? 0 : -1}
                title={conversation.title}
              >
                <span>{conversation.title}</span>
              </button>
              <button
                className="chat-history-delete-button"
                type="button"
                onClick={() => onDeleteConversation(conversation.id)}
                disabled={busy}
                tabIndex={open ? 0 : -1}
                title="Delete chat"
                aria-label={`Delete ${conversation.title}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        ) : (
          <div className="chat-history-empty">No saved chats</div>
        )}
      </div>
    </section>
  );
}
