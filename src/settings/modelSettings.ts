export const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5-20251001";

export type ModelSettings = {
  model: typeof CLAUDE_HAIKU_4_5_MODEL;
  temperature: number;
  maxOutputTokens: number;
};

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  model: CLAUDE_HAIKU_4_5_MODEL,
  temperature: 0.2,
  maxOutputTokens: 1600
};
