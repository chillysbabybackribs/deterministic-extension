import { useState } from "react";
import { X, ChevronDown, ChevronUp } from "lucide-react";
import type { CapabilityGap } from "../../conversation/conversationTypes";

export type CompanionOptInPillProps = {
  gap: CapabilityGap;
  /** Open the install/setup flow for the local engine. */
  onInstall: () => void;
  /** Dismiss this pill ("not now" — it re-appears on a later limited task). */
  onDismiss: () => void;
  /** Send a conversational deep-dive question through the normal chat pipeline. */
  onAsk: (question: string) => void;
};

/**
 * Inline opt-in pill shown on an answer that hit a capability the local
 * "background engine" could unlock. Clean and quiet: a one-line reason, an
 * Install action, an expandable "what this does" explainer, and a dismiss.
 * Dismissing is "not now" — the parent only hides THIS message's pill, so a
 * later limited task surfaces a fresh one.
 */
export function CompanionOptInPill({ gap, onInstall, onDismiss, onAsk }: CompanionOptInPillProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="companion-pill" role="note" aria-label="Optional local engine">
      <div className="companion-pill-row">
        <p className="companion-pill-copy">
          This extension is limited right now to fully complete this task. Opt in to full capabilities by installing a background engine.
        </p>
        <button
          className="companion-pill-dismiss"
          type="button"
          title="Not now"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="companion-pill-actions">
        <button className="companion-pill-install" type="button" onClick={onInstall}>
          Install the engine
        </button>
        <button
          className="companion-pill-learn"
          type="button"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((value) => !value)}
        >
          {showDetails ? <ChevronUp size={13} strokeWidth={2} /> : <ChevronDown size={13} strokeWidth={2} />}
          {showDetails ? "Hide details" : "Read what this does"}
        </button>
      </div>

      {showDetails ? (
        <div className="companion-pill-details">
          {gap.detail ? (
            // Prompt-specific explanation generated for THIS task.
            <p>{gap.detail}</p>
          ) : (
            // Fallback when no tailored explainer was produced.
            <>
              <p>{gap.reason}</p>
              <p>
                The background engine is an optional local app you install once. It runs quietly on your
                computer and lets this extension do things the browser sandbox blocks — like capturing the
                full data behind a page, even when the site restricts it.
              </p>
            </>
          )}
          <button
            className="companion-pill-ask"
            type="button"
            onClick={() => onAsk("Explain the background engine and why this task was limited — what would it let you do here?")}
          >
            Ask the chat for more
          </button>
        </div>
      ) : null}
    </div>
  );
}
