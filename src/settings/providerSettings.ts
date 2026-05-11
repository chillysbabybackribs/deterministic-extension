export type ProviderId = "anthropic";

export type ProviderSettings = {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: "anthropic",
  apiKey: "",
  baseUrl: "https://api.anthropic.com"
};
