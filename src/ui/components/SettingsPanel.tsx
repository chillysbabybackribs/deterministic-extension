import type { AppSettings } from "../../settings/settingsStore";

export type SettingsPanelProps = {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void | Promise<void>;
};

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  function update(next: Partial<AppSettings>) {
    void onChange({
      ...settings,
      ...next
    });
  }

  return (
    <section className="settings-panel">
      <div className="panel-heading">Settings</div>
      <div className="settings-grid">
        <div className="settings-row">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={settings.provider.provider}
            disabled
            onChange={(event) =>
              update({
                provider: {
                  ...settings.provider,
                  provider: event.target.value as AppSettings["provider"]["provider"]
                }
              })
            }
          >
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="model">Model</label>
          <input
            id="model"
            value={settings.model.model}
            disabled
            onChange={(event) =>
              update({
                model: {
                  ...settings.model,
                  model: event.target.value as AppSettings["model"]["model"]
                }
              })
            }
          />
        </div>

        <div className="settings-row">
          <label htmlFor="baseUrl">API base URL</label>
          <input
            id="baseUrl"
            value={settings.provider.baseUrl}
            onChange={(event) =>
              update({
                provider: {
                  ...settings.provider,
                  baseUrl: event.target.value
                }
              })
            }
          />
        </div>

        <div className="settings-row">
          <label htmlFor="apiKey">API key</label>
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

        <label className="settings-row inline">
          <input checked={settings.dev.permissiveExecution} disabled type="checkbox" readOnly />
          <span>Permissive execution</span>
        </label>

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
          <span>Debug logs</span>
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
          <span>Evidence preview</span>
        </label>
      </div>
    </section>
  );
}
