export const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5-20251001";
export const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";

export type ChatModelId =
  | typeof CLAUDE_HAIKU_4_5_MODEL
  | typeof CLAUDE_SONNET_4_6_MODEL;
export type ResearchSynthesisModelSetting =
  | "auto"
  | typeof CLAUDE_HAIKU_4_5_MODEL
  | typeof CLAUDE_SONNET_4_6_MODEL;

export type ModelSettings = {
  model: ChatModelId;
  researchSynthesisModel: ResearchSynthesisModelSetting;
  temperature: number;
  maxOutputTokens: number;
};

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  model: CLAUDE_HAIKU_4_5_MODEL,
  researchSynthesisModel: "auto",
  temperature: 0.2,
  maxOutputTokens: 1600
};

export function labelForClaudeModel(model: string): string {
  switch (model) {
    case CLAUDE_SONNET_4_6_MODEL:
      return "Sonnet 4.6";
    case CLAUDE_HAIKU_4_5_MODEL:
      return "Haiku 4.5";
    default:
      return model;
  }
}

export function labelForChatModel(model: string): string {
  return labelForClaudeModel(model);
}

export function isAnthropicChatModel(model: string): boolean {
  return model === CLAUDE_HAIKU_4_5_MODEL || model === CLAUDE_SONNET_4_6_MODEL;
}
