import { useEffect, useState } from "react";
import { Activity, Database } from "lucide-react";
import type { AppSettings } from "../../settings/settingsStore";
import {
  CLAUDE_HAIKU_4_5_MODEL,
  CLAUDE_SONNET_4_6_MODEL,
  labelForChatModel
} from "../../settings/modelSettings";
import type { WebCorpusDescriptor } from "../../webcorpus/webCorpusTypes";

export type SettingsPanelProps = {
  settings: AppSettings;
  activityCount: number;
  activityOpen: boolean;
  evidenceCount: number;
  evidenceOpen: boolean;
  showEvidence: boolean;
  onChange: (settings: AppSettings) => void | Promise<void>;
  onToggleActivity: () => void;
  onToggleEvidence: () => void;
};

export function SettingsPanel({
  settings,
  activityCount,
  activityOpen,
  evidenceCount,
  evidenceOpen,
  showEvidence,
  onChange,
  onToggleActivity,
  onToggleEvidence
}: SettingsPanelProps) {
  function update(next: Partial<AppSettings>) {
    void onChange({
      ...settings,
      ...next
    });
  }

  return (
    <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title">
      <div className="panel-heading" id="settings-panel-title">Settings</div>
      <div className="settings-grid">
        <div className="settings-section">
          <div className="settings-section-title">Panels</div>
          <div className="settings-panel-actions">
            <button
              className={activityOpen ? "settings-panel-action active" : "settings-panel-action"}
              type="button"
              onClick={onToggleActivity}
              title="Activity"
              aria-label={`Activity${activityCount ? ` (${activityCount})` : ""}`}
              aria-expanded={activityOpen}
              aria-controls="activity-drawer"
            >
              <Activity size={16} />
              <span>Activity</span>
              <span className="settings-panel-count">{activityCount}</span>
            </button>
            {showEvidence ? (
              <button
                className={evidenceOpen ? "settings-panel-action active" : "settings-panel-action"}
                type="button"
                onClick={onToggleEvidence}
                title="Evidence"
                aria-label={`Evidence${evidenceCount ? ` (${evidenceCount})` : ""}`}
                aria-expanded={evidenceOpen}
                aria-controls="evidence-drawer"
              >
                <Database size={16} />
                <span>Evidence</span>
                <span className="settings-panel-count">{evidenceCount}</span>
              </button>
            ) : null}
          </div>
          <div className="settings-note">
            Activity and evidence panels show browser, research, and workspace progress when available.
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="provider">Chat provider</label>
          <select
            id="provider"
            value={settings.provider.provider}
            disabled
            onChange={() => undefined}
          >
            <option value="anthropic">Anthropic</option>
          </select>
          <div className="settings-note">
            Chat responses use Anthropic. Gemini is only used as the fixed master router when a Gemini key is saved.
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="model">Chat model</label>
          <select
            id="model"
            value={settings.model.model}
            onChange={(event) =>
              update({
                model: {
                  ...settings.model,
                  model: event.target.value as AppSettings["model"]["model"]
                }
              })
            }
          >
            <option value={CLAUDE_HAIKU_4_5_MODEL}>Claude Haiku 4.5</option>
            <option value={CLAUDE_SONNET_4_6_MODEL}>Claude Sonnet 4.6</option>
          </select>
          <div className="settings-note">
            Haiku 4.5 is fast and economical. Sonnet 4.6 is stronger for harder reasoning and longer tasks.
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="researchSynthesisModel">Research synthesis</label>
          <select
            id="researchSynthesisModel"
            value={settings.model.researchSynthesisModel}
            onChange={(event) =>
              update({
                model: {
                  ...settings.model,
                  researchSynthesisModel: event.target.value as AppSettings["model"]["researchSynthesisModel"]
                }
              })
            }
          >
            <option value={CLAUDE_HAIKU_4_5_MODEL}>Fast</option>
            <option value="auto">Balanced</option>
            <option value={CLAUDE_SONNET_4_6_MODEL}>Best</option>
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="apiKey">Anthropic API key</label>
          <input
            id="apiKey"
            type="password"
            value={settings.provider.apiKey}
            onChange={(event) =>
              update({
                provider: {
                  ...settings.provider,
                  apiKey: event.target.value
                }
              })
            }
          />
          <div className="settings-note">
            Stored locally in this Chrome profile and sent only to Anthropic for Claude requests.
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="geminiApiKey">Gemini API key</label>
          <input
            id="geminiApiKey"
            type="password"
            value={settings.provider.geminiApiKey ?? ""}
            onChange={(event) =>
              update({
                provider: {
                  ...settings.provider,
                  geminiApiKey: event.target.value
                }
              })
            }
          />
          <div className="settings-note">
            Stored locally in this Chrome profile. Used only for the Gemini master router, not chat responses.
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="openaiApiKey">OpenAI API key</label>
          <input
            id="openaiApiKey"
            type="password"
            value={settings.provider.openaiApiKey ?? ""}
            onChange={(event) =>
              update({
                provider: {
                  ...settings.provider,
                  openaiApiKey: event.target.value
                }
              })
            }
          />
          <div className="settings-note">
            Stored locally in this Chrome profile.
          </div>
        </div>

        <div className="settings-note">
          When you ask about pages, search results, or workspace files, relevant content may be sent to the selected model provider.
        </div>

        <details className="advanced-settings">
          <summary>Advanced</summary>
          <div className="settings-grid advanced-settings-body">
            <label className="settings-row inline">
              <input
                checked={settings.dev.permissiveExecution}
                type="checkbox"
                onChange={(event) =>
                  update({
                    dev: {
                      ...settings.dev,
                      permissiveExecution: event.target.checked
                    }
                  })
                }
              />
              <span>Allow page actions</span>
            </label>
            <div className="settings-note">
              Lets the assistant click, type, and interact with pages when you ask.
            </div>

            <label className="settings-row inline">
              <input
                checked={settings.dev.showDebugLogs}
                type="checkbox"
                onChange={(event) =>
                  update({
                    dev: {
                      ...settings.dev,
                      showDebugLogs: event.target.checked
                    }
                  })
                }
              />
              <span>Show detailed activity logs</span>
            </label>

            <label className="settings-row inline">
              <input
                checked={settings.dev.showEvidencePreview}
                type="checkbox"
                onChange={(event) =>
                  update({
                    dev: {
                      ...settings.dev,
                      showEvidencePreview: event.target.checked
                    }
                  })
                }
              />
              <span>Show evidence drawer</span>
            </label>

            <div className="settings-row">
              <label htmlFor="rawModelId">Chat model ID</label>
              <input id="rawModelId" value={settings.model.model} disabled />
              <div className="settings-note">{labelForChatModel(settings.model.model)}</div>
            </div>

            <div className="settings-row">
              <label htmlFor="maxOutputTokens">Max output tokens</label>
              <input
                id="maxOutputTokens"
                min={128}
                max={64000}
                step={128}
                type="number"
                value={settings.model.maxOutputTokens}
                onChange={(event) =>
                  update({
                    model: {
                      ...settings.model,
                      maxOutputTokens: Number(event.target.value)
                    }
                  })
                }
              />
            </div>

            <MappedSitesReadout />
          </div>
        </details>
      </div>
    </section>
  );
}

/**
 * Read-only readout of the accumulated web corpus. Fetches the persisted site
 * descriptors from the service worker on mount (and via a manual refresh) so you
 * can watch the corpus fill in as you browse. No state of its own beyond what it
 * fetches.
 */
function MappedSitesReadout() {
  const [sites, setSites] = useState<WebCorpusDescriptor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setError(null);
    chrome.runtime.sendMessage({ type: "ohmygod.listWebCorpus" }, (response) => {
      if (chrome.runtime.lastError) {
        setError(chrome.runtime.lastError.message ?? "Unavailable");
        return;
      }
      if (response?.ok) {
        setSites(response.sites as WebCorpusDescriptor[]);
      } else {
        setError(response?.error ?? "Unavailable");
      }
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="settings-row">
      <label>Mapped sites</label>
      <button type="button" className="settings-panel-action" onClick={refresh}>
        Refresh
      </button>
      {error ? (
        <div className="settings-note">Could not read corpus: {error}</div>
      ) : sites === null ? (
        <div className="settings-note">Loading…</div>
      ) : sites.length === 0 ? (
        <div className="settings-note">
          No pages mapped yet. The corpus fills in when you work with a page (the actionable overlay must be active for that tab), then navigate.
        </div>
      ) : (
        <div className="settings-note" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sites.map((site) => (
            <div key={site.siteName}>
              <div style={{ fontWeight: 600 }}>
                {site.siteName} — {site.pageCount} page{site.pageCount === 1 ? "" : "s"}, {site.componentCount} components
              </div>
              <ul style={{ margin: "2px 0 0", paddingLeft: 16, listStyle: "none" }}>
                {(site.pages ?? []).map((page) => (
                  <li key={page.pageId} title={page.lastUrl} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {page.lastUrl} — {page.componentCount} component{page.componentCount === 1 ? "" : "s"}
                    {page.visitCount > 1 ? ` · ${page.visitCount} visits` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
