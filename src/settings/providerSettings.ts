/**
 * Known model providers. Only "anthropic" is wired today; "gemini"/"openai" are
 * declared so the model-selection policy and settings can be provider-agnostic
 * (their key fields already exist) without a schema change when a client lands.
 */
export type ProviderId = "anthropic" | "gemini" | "openai";

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
