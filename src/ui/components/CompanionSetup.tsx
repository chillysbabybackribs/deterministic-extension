import { CheckCircle2, Download, X, LoaderCircle } from "lucide-react";

export type CompanionSetupProps = {
  connected: boolean;
  onClose: () => void;
  /** Re-check presence now (after the user reports installing/launching). */
  onRefresh: () => void;
};

/**
 * The install/setup flow opened from the opt-in pill. Walks the user through the
 * one-time install of the local engine and auto-detects when it comes online
 * (the parent polls health; this panel just reflects `connected`). Kept simple:
 * the friction we can't remove is "download + launch once"; everything else is
 * detection.
 */
export function CompanionSetup({ connected, onClose, onRefresh }: CompanionSetupProps) {
  return (
    <div className="companion-setup-overlay" role="dialog" aria-modal="true" aria-label="Install the background engine">
      <div className="companion-setup">
        <header className="companion-setup-header">
          <h2>Background engine</h2>
          <button className="companion-setup-close" type="button" aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        {connected ? (
          <div className="companion-setup-connected">
            <CheckCircle2 size={20} strokeWidth={2} className="companion-setup-ok-icon" aria-hidden="true" />
            <div>
              <p className="companion-setup-ok-title">Connected — full mode is on.</p>
              <p className="companion-setup-ok-sub">
                The extension will now use the engine for tasks the browser can't do alone. You can close this.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="companion-setup-intro">
              The engine is a small app that runs on your computer and unlocks capabilities the browser
              blocks — like capturing the full data behind a page. Install it once; it stays available
              quietly and the extension detects it automatically.
            </p>

            <ol className="companion-setup-steps">
              <li>
                <span className="companion-setup-step-num">1</span>
                <div>
                  <p className="companion-setup-step-title">Download the engine for your system</p>
                  <button className="companion-setup-download" type="button" disabled title="Coming soon">
                    <Download size={15} strokeWidth={2} />
                    Download (coming soon)
                  </button>
                </div>
              </li>
              <li>
                <span className="companion-setup-step-num">2</span>
                <div>
                  <p className="companion-setup-step-title">Open it once</p>
                  <p className="companion-setup-step-sub">
                    It installs itself to start quietly in the background. Nothing else to configure.
                  </p>
                </div>
              </li>
              <li>
                <span className="companion-setup-step-num">3</span>
                <div>
                  <p className="companion-setup-step-title">It connects automatically</p>
                  <p className="companion-setup-step-sub companion-setup-detecting">
                    <LoaderCircle size={14} strokeWidth={2} className="companion-setup-spin" aria-hidden="true" />
                    Waiting for the engine…
                  </p>
                </div>
              </li>
            </ol>

            <div className="companion-setup-footer">
              <button className="companion-setup-recheck" type="button" onClick={onRefresh}>
                Check again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
