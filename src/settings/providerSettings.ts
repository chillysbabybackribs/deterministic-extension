export type ProviderId = "anthropic";

export type ProviderSettings = {
  provider: ProviderId;
  apiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: "anthropic",
  apiKey: "",
  geminiApiKey: "",
  openaiApiKey: ""
};
