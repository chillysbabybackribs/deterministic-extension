import { Activity, X } from "lucide-react";
import type { ExecutionLogEntry } from "../../execution/executionTypes";
import { ActivityPanel } from "./ActivityPanel";

export type ActivityDrawerProps = {
  entries: ExecutionLogEntry[];
  open: boolean;
  onClose: () => void;
};

export function ActivityDrawer({ entries, open, onClose }: ActivityDrawerProps) {
  return (
    <section
      id="activity-drawer"
      className={open ? "activity-drawer open" : "activity-drawer"}
      aria-label="Activity feed"
      aria-hidden={!open}
    >
      <header className="activity-drawer-header">
        <div className="activity-drawer-title">
          <Activity size={15} />
          <span>Activity</span>
          {entries.length ? <span className="activity-count">{entries.length}</span> : null}
        </div>
        <button
          className="icon-button drawer-close-button"
          type="button"
          onClick={onClose}
          tabIndex={open ? 0 : -1}
          title="Close activity"
          aria-label="Close activity"
        >
          <X size={16} />
        </button>
      </header>
      <div className="activity-drawer-body">
        <ActivityPanel entries={entries} maxEntries={12} />
      </div>
    </section>
  );
}
