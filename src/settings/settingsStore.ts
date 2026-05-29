import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderId,
  type ProviderSettings
} from "./providerSettings";
import {
  CLAUDE_HAIKU_4_5_MODEL,
  CLAUDE_SONNET_4_6_MODEL,
  DEFAULT_MODEL_SETTINGS,
  type ChatModelId,
  type ModelSettings,
  type ResearchSynthesisModelSetting
} from "./modelSettings";

export const DEV_PERMISSIVE_EXECUTION = true;

export type DevSettings = {
  permissiveExecution: boolean;
  showDebugLogs: boolean;
  showEvidencePreview: boolean;
};

export type AppSettings = {
  provider: ProviderSettings;
  model: ModelSettings;
  dev: DevSettings;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  provider: DEFAULT_PROVIDER_SETTINGS,
  model: DEFAULT_MODEL_SETTINGS,
  dev: {
    permissiveExecution: DEV_PERMISSIVE_EXECUTION,
    showDebugLogs: false,
    showEvidencePreview: false
  }
};

const SETTINGS_KEY = "ohmygod.settings";

export async function loadSettings(): Promise<AppSettings> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (stored) => {
        const saved = stored[SETTINGS_KEY] as Partial<AppSettings> | undefined;
        resolve(mergeSettings(saved));
      });
    });
  }

  const raw = getLocalStorage()?.getItem(SETTINGS_KEY);
  return mergeSettings(raw ? (JSON.parse(raw) as Partial<AppSettings>) : undefined);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const normalized = mergeSettings(settings);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    return;
  }

  getLocalStorage()?.setItem(SETTINGS_KEY, JSON.stringify(normalized));
}

function mergeSettings(saved?: Partial<AppSettings>): AppSettings {
  return {
    provider: {
      ...DEFAULT_APP_SETTINGS.provider,
      ...saved?.provider,
      provider: normalizeProvider(saved?.provider?.provider)
    },
    model: {
      ...DEFAULT_APP_SETTINGS.model,
      ...saved?.model,
      model: normalizeModel(saved?.model?.model),
      researchSynthesisModel: normalizeResearchSynthesisModel(saved?.model?.researchSynthesisModel),
      maxOutputTokens: normalizeMaxOutputTokens(saved?.model?.maxOutputTokens)
    },
    dev: {
      ...DEFAULT_APP_SETTINGS.dev,
      ...saved?.dev,
      permissiveExecution: typeof saved?.dev?.permissiveExecution === "boolean"
        ? saved.dev.permissiveExecution
        : DEV_PERMISSIVE_EXECUTION
    }
  };
}

function normalizeProvider(provider: unknown): ProviderId {
  return provider === "anthropic" ? provider : DEFAULT_APP_SETTINGS.provider.provider;
}

function normalizeModel(model: unknown): ChatModelId {
  return model === CLAUDE_HAIKU_4_5_MODEL || model === CLAUDE_SONNET_4_6_MODEL
    ? model
    : CLAUDE_HAIKU_4_5_MODEL;
}

function normalizeResearchSynthesisModel(model: unknown): ResearchSynthesisModelSetting {
  return model === "auto" || model === CLAUDE_HAIKU_4_5_MODEL || model === CLAUDE_SONNET_4_6_MODEL
    ? model
    : DEFAULT_APP_SETTINGS.model.researchSynthesisModel;
}

function normalizeMaxOutputTokens(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_APP_SETTINGS.model.maxOutputTokens;
  }

  return Math.min(64000, Math.max(128, Math.round(value)));
}

type LocalStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function getLocalStorage(): LocalStorageLike | undefined {
  const candidate = globalThis as typeof globalThis & {
    localStorage?: LocalStorageLike;
  };

  return candidate.localStorage;
}
