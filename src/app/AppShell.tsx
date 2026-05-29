import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import { SourceControl } from "../ui/components/SourceControl";
import type { ActiveWorkingFileDescriptor } from "../filecorpus/corpusTypes";

export type AppShellProps = {
  chat: ReactNode;
  settings: ReactNode;
  authControls?: ReactNode;
  chatBusy: boolean;
  chatHistoryOpen: boolean;
  /** The active working source (file or folder corpus), if any. */
  source?: ActiveWorkingFileDescriptor;
  sourceBusy: boolean;
  sourceIngestedAt?: string;
  sourceError?: string;
  onAttachFile: () => void;
  onAttachFolder: () => void;
  onRefreshSource: () => void;
  onClearSource: () => void;
  onToggleChatHistory: () => void;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
  settingsOpen: boolean;
};

export function AppShell({
  chat,
  settings,
  authControls,
  chatBusy,
  chatHistoryOpen,
  source,
  sourceBusy,
  sourceIngestedAt,
  sourceError,
  onAttachFile,
  onAttachFolder,
  onRefreshSource,
  onClearSource,
  onToggleChatHistory,
  onToggleSettings,
  onCloseSettings,
  settingsOpen
}: AppShellProps) {
  return (
    <div className={authControls ? "app-shell has-auth-controls" : "app-shell"}>
      <header className="topbar">
        <div className="topbar-workspace-center">
          <SourceControl
            source={source}
            busy={sourceBusy}
            ingestedAt={sourceIngestedAt}
            error={sourceError}
            onAttachFile={onAttachFile}
            onAttachFolder={onAttachFolder}
            onRefresh={onRefreshSource}
            onClear={onClearSource}
          />
        </div>
        <div className="topbar-actions">
          <button
            aria-controls="chat-history-drawer"
            aria-expanded={chatHistoryOpen}
            className={chatHistoryOpen ? "topbar-text-button active" : "topbar-text-button"}
            type="button"
            onClick={onToggleChatHistory}
            disabled={chatBusy}
            title="Chats"
          >
            Chats
          </button>
          <button
            className={settingsOpen ? "header-settings-button active" : "header-settings-button"}
            type="button"
            onClick={onToggleSettings}
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <main className="main-panel">{chat}</main>

      {authControls ? <div className="floating-auth-controls">{authControls}</div> : null}

      {settingsOpen ? (
        <div className="settings-modal-layer" onClick={onCloseSettings}>
          <div className="settings-modal-content" onClick={(event) => event.stopPropagation()}>
            {settings}
          </div>
        </div>
      ) : null}
    </div>
  );
}
