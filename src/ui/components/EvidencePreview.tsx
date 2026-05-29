import { Database, ExternalLink } from "lucide-react";
import type { EvidenceItem, EvidencePacket } from "../../evidence/evidenceTypes";

export type EvidencePreviewProps = {
  packet?: EvidencePacket;
};

export function EvidencePreview({ packet }: EvidencePreviewProps) {
  if (!packet) {
    return (
      <section className="evidence-preview">
        <div className="evidence-header">
          <span>Evidence</span>
        </div>
        <div className="empty-state">Evidence will appear here after a page, search, or workspace task.</div>
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
        {packet.items.slice(0, 4).map((item) => (
          <div className="evidence-item" key={item.id}>
            <div className="evidence-item-topline">
              <strong>{evidenceTitle(item)}</strong>
              {evidenceUrl(item) ? (
                <a
                  className="evidence-open-link"
                  href={evidenceUrl(item)}
                  rel="noreferrer"
                  target="_blank"
                  title="Open source"
                >
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </div>
            <span className="evidence-source">{evidenceSource(item)}</span>
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

function evidenceTitle(item: EvidenceItem): string {
  if ("title" in item && item.title) {
    return item.title;
  }

  if (item.type === "value") {
    return item.label;
  }

  if (item.type === "tool_failure") {
    return item.toolName;
  }

  return item.type === "warning" ? "Note" : "Source";
}

function evidenceUrl(item: EvidenceItem): string | undefined {
  return "url" in item ? item.url : item.provenance?.url;
}

function evidenceSource(item: EvidenceItem): string {
  const url = evidenceUrl(item);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  if (item.provenance?.title) {
    return item.provenance.title;
  }

  return usedForLabel(item);
}

function usedForLabel(item: EvidenceItem): string {
  if (item.provenance?.capability) {
    return item.provenance.capability;
  }

  return item.quality === "strong" ? "Used for answer" : `Used for answer · ${item.quality}`;
}
