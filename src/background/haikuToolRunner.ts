import type { ChatContextMessage } from "../conversation/conversationTypes";
import type {
  EvidenceBrowserState,
  EvidenceItem,
  EvidencePacket,
  EvidenceQuality,
  OpenedSourceEvidence,
  SearchCandidate,
  ToolFailureEvidence
} from "../evidence/evidenceTypes";
import type { ExecutionLogEntry, UniversalStepResult, VisibleBrowserAction } from "../execution/executionTypes";
import {
  callAnthropicMessage,
  extractText,
  extractToolUses,
  type AnthropicContentBlock,
  type AnthropicMessageParam,
  type AnthropicToolResultBlock
} from "../model/anthropicToolClient";
import type { AppSettings } from "../settings/settingsStore";
import { executeBrowserTool, type BrowserToolExecution } from "../tools/browserToolExecutor";
import { HAIKU_BROWSER_TOOLS } from "../tools/browserToolList";
import type { RunProgressEvent, RunResponse } from "../shared/protocol";
import {
  formatDeterministicResearchForHaiku,
  runDeterministicResearchPreflight,
  shouldRunDeterministicResearch,
  type DeterministicResearchBundle
} from "./deterministicResearchRunner";

const MAX_TOOL_ROUNDS = 8;
const MAX_TOTAL_TOOL_CALLS = 24;
const MAX_TOOL_RESULT_CHARS = 4_000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 1_200;
const MAX_RESEARCH_HISTORY_MESSAGES = 1;
const MAX_RESEARCH_HISTORY_MESSAGE_CHARS = 500;

export async function runHaikuToolChat(args: {
  userMessage: string;
  settings: AppSettings;
  history: ChatContextMessage[];
  onProgress?: (event: RunProgressEvent) => void;
}): Promise<RunResponse> {
  const activity: ExecutionLogEntry[] = [];
  const evidence = createEvidenceAccumulator(args.userMessage);
  const messages = buildConversationMessages(args.history, args.userMessage);
  let totalToolCalls = 0;

  try {
    if (shouldRunDeterministicResearch(args.userMessage)) {
      return answerWithDeterministicResearch({
        userMessage: args.userMessage,
        settings: args.settings,
        history: args.history,
        onProgress: args.onProgress,
        activity,
        evidence,
        researchDetails: "Compiling a search query, rotating one visible tab through ranked sources, and checking sufficiency.",
        synthesisDetails: "Synthesizing from deterministic source bundle without browser tools."
      });
    }

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
      activity.push(makeLog({
        level: "info",
        label: "Haiku 4.5",
        details: round === 1 ? "Sending browser tool list to Haiku." : "Continuing with tool results.",
        toolName: "claude-haiku-4-5",
        actionLabel: "Model turn",
        status: "running"
      }));

      const response = await callAnthropicMessage({
        settings: args.settings,
        system: buildSystemPrompt(),
        messages,
        tools: HAIKU_BROWSER_TOOLS
      });
      const toolUses = extractToolUses(response.content);
      const text = extractText(response.content);
      activity[activity.length - 1] = makeLog({
        level: "info",
        label: "Haiku 4.5",
        details: toolUses.length ? `Requested ${toolUses.length} browser tool call(s).` : "Returned a final answer.",
        toolName: "claude-haiku-4-5",
        actionLabel: "Model turn",
        status: "completed",
        resultSummary: text ? clip(text, 220) : undefined
      });

      if (!toolUses.length) {
        const answer = text || "I did not receive a usable answer from Haiku.";
        if (text && shouldRetryKnowledgeGapWithResearch(args.userMessage, text)) {
          return answerWithDeterministicResearch({
            userMessage: args.userMessage,
            settings: args.settings,
            history: args.history,
            onProgress: args.onProgress,
            activity,
            evidence,
            researchDetails: "The first model turn reported a knowledge gap, so running deterministic search before replying.",
            synthesisDetails: "Synthesizing a replacement answer from the researched source bundle."
          });
        }

        return {
          ok: Boolean(text),
          answer,
          activity,
          evidence: finalizeEvidence(evidence),
          error: text ? undefined : "Empty final answer."
        };
      }

      if (totalToolCalls + toolUses.length > MAX_TOTAL_TOOL_CALLS) {
        activity.push(makeLog({
          level: "warning",
          label: "Tool budget",
          details: "Haiku requested more browser tool calls than this turn allows.",
          toolName: "browser_tools",
          actionLabel: "Stop tool loop",
          status: "partial"
        }));
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content.filter(isAssistantReplayBlock)
      });

      const toolResults: AnthropicToolResultBlock[] = [];
      for (const toolUse of toolUses) {
        totalToolCalls += 1;
        const execution = await executeBrowserTool({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input
        });
        activity.push(execution.activity);
        accumulateEvidence(evidence, execution);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: stringifyToolResult(execution),
          is_error: execution.status === "failed"
        });
      }

      messages.push({
        role: "user",
        content: toolResults
      });
    }

    messages.push({
      role: "user",
      content:
        "The browser tool budget for this turn is exhausted. Answer now using only the tool results already returned. Say what is missing or uncertain."
    });
    const finalResponse = await callAnthropicMessage({
      settings: args.settings,
      system: buildSystemPrompt(),
      messages
    });
    const answer = extractText(finalResponse.content) || "I could not produce a final answer after the browser tool loop.";
    return {
      ok: Boolean(extractText(finalResponse.content)),
      answer,
      activity,
      evidence: finalizeEvidence(evidence),
      error: extractText(finalResponse.content) ? undefined : "Empty final answer."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Haiku tool chat failure.";
    activity.push(makeLog({
      level: "error",
      label: "Run failed",
      details: message,
      toolName: "browser_tools",
      actionLabel: "Run failed",
      status: "failed",
      warning: message
    }));
    evidence.failures.push(makeFailureEvidence("haiku_tool_loop", message));
    evidence.missingInfo.push(message);
    return {
      ok: false,
      answer: message,
      activity,
      evidence: finalizeEvidence(evidence),
      error: message
    };
  }
}

type EvidenceAccumulator = {
  id: string;
  createdAt: string;
  userGoal: string;
  items: EvidenceItem[];
  stepResults: UniversalStepResult[];
  warnings: string[];
  failures: ToolFailureEvidence[];
  missingInfo: string[];
  searchCandidates: SearchCandidate[];
  openedSources: OpenedSourceEvidence[];
  extractedSections: string[];
  extractedTextSample: string;
  prunedTabIds: number[];
  groupedTabIds: number[];
  focusedTab?: EvidencePacket["focusedTab"];
  visibleBrowserActions: VisibleBrowserAction[];
  browserState?: EvidenceBrowserState;
};

function buildConversationMessages(history: ChatContextMessage[], userMessage: string): AnthropicMessageParam[] {
  return [
    ...history.slice(-MAX_HISTORY_MESSAGES).map((message): AnthropicMessageParam => ({
      role: message.role,
      content: clip(message.content, MAX_HISTORY_MESSAGE_CHARS)
    })),
    {
      role: "user",
      content: clip(userMessage, 4_000)
    }
  ];
}

async function answerWithDeterministicResearch(args: {
  userMessage: string;
  settings: AppSettings;
  history: ChatContextMessage[];
  onProgress?: (event: RunProgressEvent) => void;
  activity: ExecutionLogEntry[];
  evidence: EvidenceAccumulator;
  researchDetails: string;
  synthesisDetails: string;
}): Promise<RunResponse> {
  emitProgress(args.onProgress, {
    level: "info",
    label: "Research",
    detail: args.researchDetails,
    status: "running"
  });
  args.activity.push(makeLog({
    level: "info",
    label: "Deterministic research",
    details: args.researchDetails,
    toolName: "deterministic_research",
    actionLabel: "Preflight search/extract",
    status: "running"
  }));
  const research = await runDeterministicResearchPreflight(args.userMessage, args.onProgress);
  args.activity[args.activity.length - 1] = research.execution.activity;
  args.activity.push(...makeResearchAuditLogs(research.bundle));
  accumulateEvidence(args.evidence, research.execution);

  emitProgress(args.onProgress, {
    level: "info",
    label: "Synthesis",
    detail: args.synthesisDetails,
    status: "running"
  });
  args.activity.push(makeLog({
    level: "info",
    label: "Haiku 4.5",
    details: args.synthesisDetails,
    toolName: "claude-haiku-4-5",
    actionLabel: "Research synthesis",
    status: "running"
  }));

  const synthesisResponse = await callAnthropicMessage({
    settings: args.settings,
    system: buildResearchSynthesisSystemPrompt(),
    messages: buildResearchSynthesisMessages(
      args.history,
      args.userMessage,
      formatDeterministicResearchForHaiku(research.bundle)
    )
  });
  const answer = extractText(synthesisResponse.content) || "I could not produce a final answer from the deterministic research bundle.";
  emitProgress(args.onProgress, {
    level: answer ? "info" : "error",
    label: "Synthesis",
    detail: answer ? "Final answer ready." : "Synthesis returned an empty answer.",
    status: answer ? "completed" : "failed"
  });
  args.activity[args.activity.length - 1] = makeLog({
    level: answer ? "info" : "error",
    label: "Haiku 4.5",
    details: answer
      ? `Returned a final answer from deterministic evidence cards. Input tokens: ${synthesisResponse.usage?.input_tokens ?? "unknown"}.`
      : "Returned an empty final answer.",
    toolName: "claude-haiku-4-5",
    actionLabel: "Research synthesis",
    status: answer ? "completed" : "failed",
    resultSummary: answer ? clip(answer, 220) : undefined,
    warning: answer ? undefined : "Empty final answer."
  });

  return {
    ok: Boolean(answer),
    answer,
    activity: args.activity,
    evidence: finalizeEvidence(args.evidence),
    error: answer ? undefined : "Empty final answer."
  };
}

function makeResearchAuditLogs(bundle: DeterministicResearchBundle): ExecutionLogEntry[] {
  return bundle.audit.map((entry) => makeLog({
    level: entry.status === "failed" ? "error" : entry.status === "partial" ? "warning" : "debug",
    label: entry.label,
    details: entry.summary,
    toolName: "deterministic_research",
    actionLabel: entry.label,
    status: entry.status,
    eventType: "tool",
    resultSummary: entry.summary,
    warning: entry.warning
  }));
}

function emitProgress(
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  event: Omit<RunProgressEvent, "id" | "timestamp">
): void {
  onProgress?.({
    id: makeId("progress"),
    timestamp: new Date().toISOString(),
    ...event
  });
}

function shouldRetryKnowledgeGapWithResearch(userMessage: string, answer: string): boolean {
  if (!isKnowledgeGapAnswer(answer)) {
    return false;
  }

  const lowerPrompt = userMessage.trim().toLowerCase();
  if (!lowerPrompt || /\b(current|this)\s+(tab|page|site|website)\b/.test(lowerPrompt)) {
    return false;
  }

  if (/\b(my|your|yourself|this conversation|this chat)\b/.test(lowerPrompt) && !hasExternalTopicCue(userMessage)) {
    return false;
  }

  return true;
}

function isKnowledgeGapAnswer(answer: string): boolean {
  return /\b(?:i\s+)?(?:don't|do not|doesn't|does not)\s+have\s+(?:specific\s+)?(?:information|knowledge|details)\b/i.test(answer) ||
    /\b(?:not|isn't|is not)\s+(?:in|part of)\s+(?:my|the)\s+knowledge\s+base\b/i.test(answer) ||
    /\b(?:outside|beyond)\s+(?:my\s+)?(?:training|knowledge|knowledge cutoff)\b/i.test(answer) ||
    /\b(?:i'm|i am)\s+not\s+(?:familiar|aware)\s+with\b/i.test(answer) ||
    /\bthis\s+could\s+refer\s+to\b/i.test(answer);
}

function hasExternalTopicCue(value: string): boolean {
  return /\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)*\b/.test(value) ||
    /\b(?:api|app|automation|browser|company|docs|framework|library|llm|model|product|protocol|sdk|tool|website)\b/i.test(value) ||
    /https?:\/\/\S+|[a-z0-9-]+\.(?:com|org|net|io|dev|ai|app|co|edu|gov)\b/i.test(value);
}

function buildResearchSynthesisMessages(
  history: ChatContextMessage[],
  userMessage: string,
  sourceBundle: string
): AnthropicMessageParam[] {
  return [
    ...history.slice(-MAX_RESEARCH_HISTORY_MESSAGES).map((message): AnthropicMessageParam => ({
      role: message.role,
      content: clip(message.content, MAX_RESEARCH_HISTORY_MESSAGE_CHARS)
    })),
    {
      role: "user",
      content: [
        `User prompt: ${clip(userMessage, 2_000)}`,
        "",
        sourceBundle,
        "",
        "Answer the user from the deterministic source bundle above. Give the best-supported answer from the extracted evidence.",
        "When listing or citing sources, use clean markdown links with descriptive labels from the source bundle, like [Official overview](https://example.com). Do not show naked URLs unless the URL itself is the answer.",
        "Clearly label uncertainty only where a claim is not directly supported."
      ].join("\n")
    }
  ];
}

function buildSystemPrompt(): string {
  const now = new Date();
  const currentDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const currentTime = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });

  return [
    "You are Claude Haiku 4.5 running inside a Chrome sidepanel assistant.",
    `Date/time: ${currentDate}, ${currentTime}.`,
    "Answer ordinary chat directly.",
    "Search/web prompts are handled before this tool loop by deterministic preflight.",
    "Use tools only for URLs, current/open page questions, history questions, and tab actions.",
    "Only claim actions confirmed by tool results. If evidence is thin or tools fail, say so.",
    "Be concise and grounded."
  ].join("\n");
}

function buildResearchSynthesisSystemPrompt(): string {
  const now = new Date();
  const currentDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const currentTime = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });

  return [
    "You are Claude Haiku 4.5 running inside a Chrome sidepanel assistant.",
    `Date/time: ${currentDate}, ${currentTime}.`,
    "A deterministic research preflight already collected the source bundle.",
    "Use only that bundle plus conversation context for web/current claims.",
    "Do not infer exact prices, rankings, post titles, dates, or user sentiment unless present in evidence cards.",
    "Do not claim you browsed. If evidence is limited, still answer from the strongest extracted evidence and mark unsupported gaps precisely.",
    "Use descriptive markdown source links instead of naked URLs.",
    "Answer concisely and cite/source URLs when useful."
  ].join("\n");
}

function stringifyToolResult(execution: BrowserToolExecution): string {
  return clip(JSON.stringify({
    toolName: execution.toolName,
    status: execution.status,
    summary: execution.summary,
    output: execution.output,
    warnings: execution.warnings,
    error: execution.error
  }, null, 2), MAX_TOOL_RESULT_CHARS);
}

function createEvidenceAccumulator(userGoal: string): EvidenceAccumulator {
  return {
    id: makeId("evidence_packet"),
    createdAt: new Date().toISOString(),
    userGoal,
    items: [],
    stepResults: [],
    warnings: [],
    failures: [],
    missingInfo: [],
    searchCandidates: [],
    openedSources: [],
    extractedSections: [],
    extractedTextSample: "",
    prunedTabIds: [],
    groupedTabIds: [],
    visibleBrowserActions: []
  };
}

function accumulateEvidence(evidence: EvidenceAccumulator, execution: BrowserToolExecution): void {
  evidence.items.push(...execution.evidenceItems);
  evidence.stepResults.push(execution.stepResult);
  evidence.warnings.push(...execution.warnings);
  evidence.failures.push(...execution.failures);
  evidence.searchCandidates.push(...execution.searchCandidates);
  evidence.openedSources.push(...execution.openedSources);
  evidence.extractedSections.push(...execution.extractedSections);
  if (execution.extractedTextSample) {
    evidence.extractedTextSample = evidence.extractedTextSample
      ? `${evidence.extractedTextSample}\n\n${execution.extractedTextSample}`.slice(0, 20_000)
      : execution.extractedTextSample.slice(0, 20_000);
  }
  evidence.prunedTabIds.push(...execution.prunedTabIds);
  evidence.groupedTabIds.push(...execution.groupedTabIds);
  evidence.visibleBrowserActions.push(...execution.visibleActions);
  if (execution.focusedTab) {
    evidence.focusedTab = execution.focusedTab;
  }
  if (execution.browserState) {
    evidence.browserState = mergeBrowserState(evidence.browserState, execution.browserState);
  }
  if (execution.status === "failed" && execution.error) {
    evidence.missingInfo.push(execution.error);
  }
}

function finalizeEvidence(accumulator: EvidenceAccumulator): EvidencePacket {
  const uniqueWarnings = unique(accumulator.warnings);
  const quality = determineQuality(accumulator);
  return {
    id: accumulator.id,
    createdAt: accumulator.createdAt,
    userGoal: accumulator.userGoal,
    quality,
    summary: summarizeEvidence(accumulator, quality),
    items: accumulator.items,
    stepResults: accumulator.stepResults,
    warnings: uniqueWarnings,
    failures: accumulator.failures,
    missingInfo: unique(accumulator.missingInfo),
    searchCandidates: uniqueCandidates(accumulator.searchCandidates),
    openedSources: accumulator.openedSources,
    strongestCandidate: accumulator.searchCandidates[0],
    extractedSections: unique(accumulator.extractedSections).slice(0, 80),
    extractedTextSample: accumulator.extractedTextSample,
    extractionQuality: accumulator.extractedTextSample ? "strong" : accumulator.items.length ? "partial" : "thin",
    prunedTabIds: uniqueNumbers(accumulator.prunedTabIds),
    groupedTabIds: uniqueNumbers(accumulator.groupedTabIds),
    focusedTab: accumulator.focusedTab,
    visibleBrowserActions: accumulator.visibleBrowserActions,
    browserState: accumulator.browserState
  };
}

function determineQuality(accumulator: EvidenceAccumulator): EvidenceQuality {
  if (accumulator.failures.length && !accumulator.items.length) {
    return "failed";
  }

  if (accumulator.extractedTextSample || accumulator.items.length >= 3) {
    return accumulator.failures.length ? "partial" : "strong";
  }

  if (accumulator.items.length || accumulator.searchCandidates.length) {
    return "partial";
  }

  return "thin";
}

function summarizeEvidence(accumulator: EvidenceAccumulator, quality: EvidenceQuality): string {
  if (quality === "failed") {
    return "Browser tool execution failed before useful evidence was collected.";
  }

  return [
    `${accumulator.stepResults.length} tool call(s)`,
    `${accumulator.items.length} evidence item(s)`,
    `${accumulator.searchCandidates.length} search candidate(s)`,
    `${accumulator.openedSources.length} opened tab(s)`
  ].join(", ");
}

function mergeBrowserState(
  current: EvidenceBrowserState | undefined,
  next: EvidenceBrowserState
): EvidenceBrowserState {
  return {
    activeTab: next.activeTab ?? current?.activeTab,
    currentPage: next.currentPage ?? current?.currentPage,
    openedTabs: [...(current?.openedTabs ?? []), ...next.openedTabs]
  };
}

function isAssistantReplayBlock(block: AnthropicContentBlock): block is AnthropicContentBlock {
  return block.type === "text" || block.type === "tool_use";
}

function makeLog(args: Omit<ExecutionLogEntry, "id" | "timestamp">): ExecutionLogEntry {
  return {
    id: makeId("log"),
    timestamp: new Date().toISOString(),
    ...args
  };
}

function makeFailureEvidence(toolName: string, error: string): ToolFailureEvidence {
  const createdAt = new Date().toISOString();
  return {
    id: makeId("failure"),
    createdAt,
    type: "tool_failure",
    evidenceClass: "failed_capability",
    quality: "failed",
    summary: error,
    warnings: [error],
    toolName,
    error,
    provenance: {
      toolName,
      collectedAt: createdAt
    }
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function uniqueCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const uniqueList: SearchCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) {
      continue;
    }
    seen.add(candidate.url);
    uniqueList.push(candidate);
  }

  return uniqueList;
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 30)}\n[truncated ${value.length - maxChars + 30} chars]`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
