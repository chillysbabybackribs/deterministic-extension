import type { UniversalStepResult, VisibleBrowserAction } from "../execution/executionTypes";

export type EvidenceQuality = "strong" | "partial" | "thin" | "failed" | "uncertain";
export type EvidenceClass =
  | "executed_tool"
  | "unavailable_capability"
  | "failed_capability"
  | "llm_general_knowledge_fallback";

export type SearchCandidate = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  domain?: string;
};

export type OpenedSourceEvidence = {
  tabId?: number;
  url?: string;
  title?: string;
  wasStrongest?: boolean;
};

export type EvidenceProvenance = {
  stepId?: string;
  capability?: string;
  toolName?: string;
  url?: string;
  title?: string;
  tabId?: number;
  collectedAt: string;
};

export type EvidenceBase = {
  id: string;
  createdAt: string;
  evidenceClass: EvidenceClass;
  quality: EvidenceQuality;
  summary: string;
  warnings: string[];
  provenance?: EvidenceProvenance;
};

export type SourceEvidence = EvidenceBase & {
  type: "source";
  url?: string;
  title?: string;
  sourceType?: string;
};

export type PageEvidence = EvidenceBase & {
  type: "page";
  url?: string;
  title?: string;
  headings?: string[];
  textSample?: string;
};

export type ValueEvidence = EvidenceBase & {
  type: "value";
  label: string;
  value: unknown;
};

export type WarningEvidence = EvidenceBase & {
  type: "warning";
};

export type ToolFailureEvidence = EvidenceBase & {
  type: "tool_failure";
  toolName: string;
  error: string;
};

export type EvidenceItem =
  | SourceEvidence
  | PageEvidence
  | ValueEvidence
  | WarningEvidence
  | ToolFailureEvidence;

export type EvidenceBrowserState = {
  activeTab?: {
    tabId?: number;
    title?: string;
    url?: string;
  };
  openedTabs: Array<{
    tabId?: number;
    title?: string;
    url?: string;
  }>;
  currentPage?: {
    title?: string;
    url?: string;
  };
};

export type EvidencePacket = {
  id: string;
  createdAt: string;
  userGoal?: string;
  quality: EvidenceQuality;
  summary: string;
  items: EvidenceItem[];
  stepResults: UniversalStepResult[];
  warnings: string[];
  failures: ToolFailureEvidence[];
  missingInfo: string[];
  searchCandidates: SearchCandidate[];
  openedSources: OpenedSourceEvidence[];
  strongestCandidate?: SearchCandidate;
  extractedSections: string[];
  extractedTextSample: string;
  extractionQuality: EvidenceQuality;
  prunedTabIds: number[];
  groupedTabIds: number[];
  focusedTab?: {
    tabId?: number;
    url?: string;
    title?: string;
  };
  visibleBrowserActions: VisibleBrowserAction[];
  browserState?: EvidenceBrowserState;
};
