import { Database, X } from "lucide-react";
import type { EvidencePacket } from "../../evidence/evidenceTypes";
import { EvidencePreview } from "./EvidencePreview";

export type EvidenceDrawerProps = {
  packet?: EvidencePacket;
  open: boolean;
  onClose: () => void;
};

export function EvidenceDrawer({ packet, open, onClose }: EvidenceDrawerProps) {
  return (
    <section
      id="evidence-drawer"
      className={open ? "activity-drawer open" : "activity-drawer"}
      aria-label="Evidence"
      aria-hidden={!open}
    >
      <header className="activity-drawer-header">
        <div className="activity-drawer-title">
          <Database size={15} />
          <span>Evidence</span>
          {packet ? <span className="quality-pill">{packet.quality}</span> : null}
        </div>
        <button
          className="icon-button drawer-close-button"
          type="button"
          onClick={onClose}
          tabIndex={open ? 0 : -1}
          title="Close evidence"
          aria-label="Close evidence"
        >
          <X size={16} />
        </button>
      </header>
      <div className="activity-drawer-body">
        <EvidencePreview packet={packet} />
      </div>
    </section>
  );
}
