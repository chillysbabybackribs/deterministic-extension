import { Volume2, X } from "lucide-react";
import { createPortal } from "react-dom";

export type SourceInfoModalProps = {
  onClose: () => void;
};

/**
 * The "how it works" explainer for connecting a file/folder. A clean
 * dictionary-style definition of "deterministic," then a short plain-language
 * note on how it applies to this extension — no implementation detail.
 */
export function SourceInfoModal({ onClose }: SourceInfoModalProps) {
  return createPortal(
    <div className="source-info-layer" onClick={onClose}>
      <div
        className="source-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-info-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="source-info-close" type="button" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>

        <div className="dict-head">
          <span className="dict-speaker" aria-hidden="true"><Volume2 size={18} /></span>
          <div>
            <h2 id="source-info-title" className="dict-word">deterministic</h2>
            <span className="dict-pronunciation">/dəˌtərməˈnistik/</span>
          </div>
        </div>

        <p className="dict-definition">
          Something is <strong>deterministic</strong> <mark>if its outcome is entirely predictable, with
          zero element of randomness</mark>. Given the same input, it produces the exact same result
          every single time.
        </p>

        <div className="dict-applied">
          <h3>How it works here</h3>
          <p>
            Your file or folder is read and organized once. After that, every question pulls the same
            exact passages from it — completely, with the source shown — instead of the model guessing,
            grabbing the wrong file, or answering differently each time.
          </p>
          <p>
            And because that lookup is deterministic, it adds no AI cost: the assistant only works to
            understand your question and write the answer.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
