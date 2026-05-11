import type { ExecutionLogEntry } from "../../execution/executionTypes";
import { ToolStatus } from "./ToolStatus";

export type ActivityPanelProps = {
  entries: ExecutionLogEntry[];
  maxEntries?: number;
};

export function ActivityPanel({ entries, maxEntries = 6 }: ActivityPanelProps) {
  if (!entries.length) {
    return <div className="empty-state">No activity yet.</div>;
  }

  return (
    <div className="activity-list">
      {entries.slice(-maxEntries).map((entry) => (
        <ToolStatus entry={entry} key={entry.id} />
      ))}
    </div>
  );
}
