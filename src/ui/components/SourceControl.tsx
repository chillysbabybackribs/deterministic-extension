import { File, FolderOpen, HelpCircle, Loader2, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { ActiveWorkingFileDescriptor } from "../../filecorpus/corpusTypes";
import { SourceInfoModal } from "./SourceInfoModal";

const ATTACH_TOOLTIP = "Searches the whole source deterministically (no extra model calls) and cites the exact passages.";

export type SourceControlProps = {
  source?: ActiveWorkingFileDescriptor;
  busy: boolean;
  /** ISO timestamp of the last ingest, for the "Updated Nm ago" tooltip. */
  ingestedAt?: string;
  error?: string;
  onAttachFile: () => void;
  onAttachFolder: () => void;
  onRefresh: () => void;
  onClear: () => void;
};

function relativeTime(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export function SourceControl({
  source,
  busy,
  ingestedAt,
  error,
  onAttachFile,
  onAttachFolder,
  onRefresh,
  onClear
}: SourceControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  // Empty state — two direct buttons (folder / file). The browser exposes
  // separate folder and file pickers, so each button opens its own picker on
  // the same click (preserving the required user gesture). No menu layer.
  if (!source) {
    return (
      <div className="source-control">
        <button
          className="source-help-button"
          type="button"
          onClick={() => setHelpOpen((open) => !open)}
          title="How it works"
          aria-label="How connecting a source works"
          aria-expanded={helpOpen}
        >
          <HelpCircle size={15} />
        </button>
        <button
          className="source-connect-button source-connect-icon"
          type="button"
          disabled={busy}
          onClick={onAttachFolder}
          title={`Connect a folder. ${ATTACH_TOOLTIP}`}
          aria-label="Connect a folder"
        >
          {busy ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />}
        </button>
        <button
          className="source-connect-button source-connect-icon"
          type="button"
          disabled={busy}
          onClick={onAttachFile}
          title={`Connect a file. ${ATTACH_TOOLTIP}`}
          aria-label="Connect a file"
        >
          <File size={16} />
        </button>
        {error ? <span className="source-error-text">{error}</span> : null}
        {helpOpen ? <SourceInfoModal onClose={() => setHelpOpen(false)} /> : null}
      </div>
    );
  }

  // Active state — source name + progress + refresh + clear.
  const Icon = source.sourceType === "folder" ? FolderOpen : File;
  const updated = relativeTime(ingestedAt);
  const progressLabel = source.building && source.progress
    ? `indexing ${source.progress.filesDone}${source.progress.filesTotal ? `/${source.progress.filesTotal}` : ""}`
    : undefined;

  return (
    <div className="source-control connected">
      <span className="source-name" title={source.fileName}>
        <Icon size={15} />
        <span className="source-name-label">{source.fileName}</span>
      </span>
      {progressLabel ? (
        <span className="source-progress">{progressLabel}</span>
      ) : (
        <span className="source-meta">
          {source.sourceType === "folder" && source.fileCount !== undefined ? `${source.fileCount} files` : `${source.unitCount} units`}
        </span>
      )}
      <button
        className="source-refresh"
        type="button"
        disabled={busy}
        onClick={onRefresh}
        title={updated ? `Updated ${updated} — click to re-index` : "Re-index this source"}
        aria-label="Re-index source"
      >
        {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
      </button>
      <button
        className="source-clear"
        type="button"
        disabled={busy}
        onClick={onClear}
        title="Disconnect this source"
        aria-label="Disconnect source"
      >
        <X size={14} />
      </button>
    </div>
  );
}
