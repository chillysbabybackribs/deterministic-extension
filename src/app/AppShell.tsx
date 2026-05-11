import { Settings } from "lucide-react";
import type { ReactNode } from "react";

export type AppShellProps = {
  chat: ReactNode;
  settings: ReactNode;
  settingsOpen: boolean;
  onToggleSettings: () => void;
};

export function AppShell({
  chat,
  settings,
  settingsOpen,
  onToggleSettings
}: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="app-title">Browser Chat</div>
          <div className="app-subtitle">V2 scaffold</div>
        </div>
        <button
          className={settingsOpen ? "icon-button active" : "icon-button"}
          type="button"
          onClick={onToggleSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </header>

      <main className="main-panel">{chat}</main>

      {settings}
    </div>
  );
}
