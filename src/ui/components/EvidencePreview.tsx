import { Database } from "lucide-react";
import type { EvidencePacket } from "../../evidence/evidenceTypes";

export type EvidencePreviewProps = {
  packet?: EvidencePacket;
};

export function EvidencePreview({ packet }: EvidencePreviewProps) {
  if (!packet) {
    return (
      <section className="evidence-preview">
        <div className="evidence-header">
          <span>Evidence</span>
          <span className="quality-pill">empty</span>
        </div>
        <div className="empty-state">No evidence yet.</div>
      </section>
    );
  }

  return (
    <section className="evidence-preview">
      <div className="evidence-header">
        <span>
          <Database size={14} /> Evidence
        </span>
        <span className="quality-pill">{packet.quality}</span>
      </div>
      <div className="evidence-list">
        {packet.stepResults.slice(0, 3).map((step) => (
          <div className="evidence-item" key={`${packet.id}_${step.stepId}`}>
            <strong>{step.status}</strong>
            <span>{step.capability}</span>
          </div>
        ))}
        {packet.items.slice(0, 4).map((item) => (
          <div className="evidence-item" key={item.id}>
            <strong>{item.type}</strong>
            <span>{item.summary}</span>
          </div>
        ))}
        {packet.missingInfo.slice(0, 2).map((missing) => (
          <div className="evidence-item" key={`${packet.id}_${missing}`}>
            <strong>missing</strong>
            <span>{missing}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
