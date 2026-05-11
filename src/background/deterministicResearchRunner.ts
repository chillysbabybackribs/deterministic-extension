import type {
  EvidenceBrowserState,
  EvidenceItem,
  OpenedSourceEvidence,
  SearchCandidate,
  ToolFailureEvidence
} from "../evidence/evidenceTypes";
import type {
  BrowserExecutionStatus,
  ExecutionLogEntry,
  ToolExecutionResult,
  UniversalStepResult,
  VisibleBrowserAction
} from "../execution/executionTypes";
import type { RunProgressEvent } from "../shared/protocol";
import { snapshotTab, type PageSnapshot } from "../tools/browserToolExecutor";
import type { BrowserToolExecution } from "../tools/browserToolExecutor";

const SEARCH_TIMEOUT_MS = 4500;
const VISIBLE_TAB_TIMEOUT_MS = 7000;
const EXTRACTABLE_CONTENT_TIMEOUT_MS = 6000;
const EXTRACTABLE_CONTENT_POLL_MS = 500;
const MIN_EXTRACTABLE_TEXT_CHARS = 400;
const HOMEPAGE_DEEPEN_TEXT_CHARS = 1200;
const INTERNAL_LINK_SCORE_THRESHOLD = 12;
const BACKGROUND_FETCH_TIMEOUT_MS = 6000;
const CANDIDATE_BATCH_SIZE = 6;
const GOOGLE_RESULT_POOL_SIZE = 20;
const MIN_SEARCH_PROVIDER_CANDIDATES = 8;
const MAX_BACKGROUND_TEXT_CHARS = 4500;
const MAX_VISIBLE_TEXT_CHARS = 8000;
const MAX_EVIDENCE_CARD_PASSAGES = 2;
const MAX_EVIDENCE_PASSAGE_CHARS = 360;
const MAX_EVIDENCE_FACTS = 5;
const MAX_SOURCE_PROMPT_CHARS = 3200;
const MIN_SUFFICIENT_SOURCES = 3;
const MIN_SUFFICIENT_DOMAIN_COUNT = 2;
const MIN_SUFFICIENT_PASSAGES = 5;
const MIN_SUFFICIENT_COVERAGE_SCORE = 70;
const MAX_INTERNAL_DEPTH_SAFETY = 2;
const MAX_INTERNAL_VISITS_PER_CANDIDATE_SAFETY = 3;
const MAX_VISIBLE_VISITS_SAFETY = 40;
const MAX_CONSECUTIVE_UNHELPFUL_VISITS_SAFETY = 10;
const MAX_SERP_PAGES_PER_QUERY_SAFETY = 2;
const GOOGLE_RESULTS_PER_PAGE = 10;

export type DeterministicResearchSource = {
  rank: number;
  url: string;
  title: string;
  domain?: string;
  snippet?: string;
  description?: string;
  headings: string[];
  text: string;
  status: "ok" | "partial" | "failed";
  extractionMethod: "visible_tab" | "background_fetch";
  tabId?: number;
  httpStatus?: number;
  error?: string;
  elapsedMs: number;
};

export type DeterministicResearchBundle = {
  originalPrompt: string;
  searchQuery: string;
  googleSearchUrl: string;
  startedAt: string;
  completedAt: string;
  timingsMs: {
    queryCompile: number;
    search: number;
    visibleTopResult: number;
    backgroundResults: number;
    total: number;
  };
  candidates: SearchCandidate[];
  sources: DeterministicResearchSource[];
  evidenceCards: DeterministicEvidenceCard[];
  sufficiency: ResearchSufficiencyReport;
  audit: DeterministicResearchAuditEntry[];
  warnings: string[];
};

export type DeterministicEvidenceCard = {
  rank: number;
  url: string;
  title: string;
  domain?: string;
  status: "ok" | "thin" | "blocked" | "failed";
  reasonSelected: string;
  relevantPassages: string[];
  extractedFacts: string[];
  publishedDate?: string;
  warning?: string;
};

export type DeterministicResearchAuditEntry = {
  label: string;
  status: BrowserExecutionStatus;
  summary: string;
  warning?: string;
};

export type ResearchSufficiencyReport = {
  status: "sufficient" | "insufficient" | "exhausted";
  coverageScore: number;
  usableSourceCount: number;
  diverseDomainCount: number;
  relevantPassageCount: number;
  freshnessSatisfied: boolean;
  requirements: Array<{
    label: string;
    passed: boolean;
    summary: string;
  }>;
  nextAction?: string;
};

type CandidateLookup = {
  candidates: SearchCandidate[];
  googleSearchUrl: string;
  visibleSearchTabId?: number;
  warnings: string[];
  audit: DeterministicResearchAuditEntry[];
};

type SearchIntent = {
  prompt: string;
  query: string;
  terms: string[];
  namedDomains: string[];
  namedSiteNames: string[];
  freshness: boolean;
  architecture: boolean;
  socialDiscussion: boolean;
  video: boolean;
};

type SourceClass =
  | "article"
  | "blog"
  | "code"
  | "docs"
  | "forum"
  | "generic"
  | "official"
  | "research"
  | "social"
  | "video";

type ScoredCandidate = {
  candidate: SearchCandidate;
  score: number;
  index: number;
};

type VisibleSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type VisibleCandidateExtractionResult = {
  source: DeterministicResearchSource;
  visits: DeterministicResearchSource[];
};

type VisibleRotationResult = {
  sources: DeterministicResearchSource[];
  visits: DeterministicResearchSource[];
  tabId?: number;
};

type SearchPlan = {
  query: string;
  label: string;
  start: number;
};

export function shouldRunDeterministicResearch(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase();
  if (!text) {
    return false;
  }

  if (/\b(current|this)\s+(tab|page|site|website)\b/.test(text)) {
    return false;
  }

  if (/\b(close|group|list|reload|navigate|open)\s+(my\s+)?tabs?\b/.test(text)) {
    return false;
  }

  if (/https?:\/\/\S+/i.test(userMessage)) {
    return true;
  }

  if (hasNamedSiteIntent(userMessage) || hasSocialDiscussionIntent(text)) {
    return true;
  }

  if (hasExplicitResearchIntent(text)) {
    return true;
  }

  return isLikelyResearchableKnowledgePrompt(userMessage);
}

export async function runDeterministicResearchPreflight(userMessage: string, onProgress?: (event: RunProgressEvent) => void): Promise<{
  execution: BrowserToolExecution;
  bundle: DeterministicResearchBundle;
}> {
  const startedAt = new Date().toISOString();
  const totalStarted = Date.now();
  const audit: DeterministicResearchAuditEntry[] = [];

  const queryStarted = Date.now();
  const searchQuery = compileSearchQuery(userMessage);
  const searchIntent = buildSearchIntent(userMessage, searchQuery);
  const queryCompile = Date.now() - queryStarted;
  emitProgress(onProgress, {
    level: "info",
    label: "Query",
    detail: searchQuery,
    status: "completed"
  });
  audit.push({
    label: "Query",
    status: "completed",
    summary: `"${searchQuery}" (${queryCompile}ms)`
  });

  const searchStarted = Date.now();
  const collection = await collectDeterministicResearchSources(userMessage, searchQuery, searchIntent, onProgress);
  const searchMs = Date.now() - searchStarted;
  audit.push(...collection.audit);
  audit.push({
    label: "Selected links",
    status: collection.candidates.length ? "completed" : "failed",
    summary: collection.candidates.length
      ? collection.candidates
          .map((candidate, index) => {
            const sourceClass = classifySource(candidate);
            const score = Math.round(scoreCandidate(candidate, searchIntent, index));
            return `${index + 1}. ${candidate.domain ?? domainFromUrl(candidate.url) ?? candidate.url} (${sourceClass}, ${score})`;
          })
          .join(" | ")
      : "No candidates selected.",
    warning: collection.warnings[0]
  });

  const evidenceCards = buildEvidenceCards(collection.sources, searchIntent);
  const sufficiency = collection.sufficiency.status === "sufficient"
    ? collection.sufficiency
    : {
        ...collection.sufficiency,
        status: "exhausted" as const
      };
  audit.push({
    label: "Evidence cards",
    status: evidenceCards.some((card) => card.status === "ok") ? "completed" : "partial",
    summary: `${evidenceCards.filter((card) => card.status === "ok").length}/${evidenceCards.length} usable card(s): ${evidenceCards.map((card) => `${card.rank}.${card.status}`).join(", ")}`
  });
  audit.push({
    label: "Sufficiency",
    status: sufficiency.status === "sufficient" ? "completed" : "partial",
    summary: `${sufficiency.status}: coverage ${sufficiency.coverageScore}, ${sufficiency.usableSourceCount} usable source(s), ${sufficiency.diverseDomainCount} domain(s), ${sufficiency.relevantPassageCount} relevant passage(s).`,
    warning: sufficiency.nextAction
  });
  emitProgress(onProgress, {
    level: sufficiency.status === "sufficient" ? "info" : "warning",
    label: "Sufficiency",
    detail: `${sufficiency.status}: coverage ${sufficiency.coverageScore}, ${sufficiency.usableSourceCount} source(s), ${sufficiency.diverseDomainCount} domain(s), ${sufficiency.relevantPassageCount} passage(s).`,
    status: sufficiency.status === "sufficient" ? "completed" : "partial"
  });
  const warnings = [
    ...collection.warnings,
    ...collection.sources.filter((source) => source.error).map((source) => `${source.domain ?? source.url}: ${source.error}`)
  ];
  const completedAt = new Date().toISOString();
  const bundle: DeterministicResearchBundle = {
    originalPrompt: userMessage,
    searchQuery,
    googleSearchUrl: collection.googleSearchUrl,
    startedAt,
    completedAt,
    timingsMs: {
      queryCompile,
      search: searchMs,
      visibleTopResult: collection.visibleMs,
      backgroundResults: collection.backgroundMs,
      total: Date.now() - totalStarted
    },
    candidates: collection.candidates,
    sources: collection.sources,
    evidenceCards,
    sufficiency,
    audit,
    warnings
  };

  return {
    execution: makeResearchExecution(bundle),
    bundle
  };
}

export function formatDeterministicResearchForHaiku(bundle: DeterministicResearchBundle): string {
  const cardBlocks = bundle.evidenceCards
    .map((card) => {
      const passages = card.relevantPassages.length
        ? card.relevantPassages.map((passage) => `- ${passage}`).join("\n")
        : "- No relevant passage extracted.";
      const facts = card.extractedFacts.length
        ? card.extractedFacts.map((fact) => `- ${fact}`).join("\n")
        : undefined;
      return [
        `Source ${card.rank} (${card.status})`,
        `Title: ${card.title}`,
        `Source link: [${escapeMarkdownLinkText(citationLabelForCard(card))}](${card.url})`,
        card.publishedDate ? `Date: ${card.publishedDate}` : undefined,
        `Selected because: ${card.reasonSelected}`,
        card.warning ? `Warning: ${card.warning}` : undefined,
        facts ? `Facts:\n${facts}` : undefined,
        `Relevant passages:\n${passages}`
      ].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");

  return clip([
    "Deterministic evidence cards. No raw page text was provided.",
    `Original user prompt: ${bundle.originalPrompt}`,
    `Compiled search query: ${bundle.searchQuery}`,
    `Sufficiency: ${bundle.sufficiency.status} (coverage ${bundle.sufficiency.coverageScore}; ${bundle.sufficiency.usableSourceCount} usable source(s); ${bundle.sufficiency.diverseDomainCount} domain(s); ${bundle.sufficiency.relevantPassageCount} passage(s))`,
    bundle.sufficiency.requirements.length
      ? `Sufficiency requirements: ${bundle.sufficiency.requirements.map((requirement) => `${requirement.passed ? "pass" : "missing"} ${requirement.label}: ${requirement.summary}`).join(" | ")}`
      : undefined,
    bundle.warnings.length ? `Warnings: ${bundle.warnings.slice(0, 4).join(" | ")}` : undefined,
    "",
    "Evidence:",
    cardBlocks || "No usable evidence cards were extracted."
  ].filter((line) => line !== undefined).join("\n"), MAX_SOURCE_PROMPT_CHARS);
}

function citationLabelForCard(card: DeterministicEvidenceCard): string {
  const domain = card.domain ?? domainFromUrl(card.url) ?? "";
  const url = safeUrl(card.url);
  const path = url?.pathname.toLowerCase() ?? "";
  const title = card.title.toLowerCase();

  if (domainMatches(domain, "github.com")) {
    return "GitHub repository";
  }
  if (domainMatches(domain, "reddit.com") || domainMatches(domain, "news.ycombinator.com")) {
    return "Community discussion";
  }
  if (/\b(api reference|reference)\b/i.test(card.title) || path.includes("api-reference") || path.includes("/reference")) {
    return "API reference";
  }
  if (/\b(changelog|release notes?|releases?)\b/i.test(card.title) || /\/(changelog|releases?|release-notes)\b/.test(path)) {
    return "Changelog";
  }
  if (/\b(docs?|documentation|guide|guides|developer|developers)\b/i.test(card.title) || /\/(docs?|documentation|guides?|developers?)\b/.test(path)) {
    return "Official docs";
  }
  if (classifySource({
    id: "citation",
    title: card.title,
    url: card.url,
    domain: card.domain
  }) === "official") {
    return "Official overview";
  }
  if (title.includes("overview") || path === "/" || path === "") {
    return "Official overview";
  }

  return clip(card.title.replace(/\s*[-|]\s*[^-|]+$/, "").trim() || domain || "Source", 64);
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]\\]/g, "\\$&");
}

async function collectDeterministicResearchSources(
  userMessage: string,
  searchQuery: string,
  intent: SearchIntent,
  onProgress?: (event: RunProgressEvent) => void
): Promise<{
  candidates: SearchCandidate[];
  sources: DeterministicResearchSource[];
  sufficiency: ResearchSufficiencyReport;
  googleSearchUrl: string;
  audit: DeterministicResearchAuditEntry[];
  warnings: string[];
  visibleMs: number;
  backgroundMs: number;
}> {
  const audit: DeterministicResearchAuditEntry[] = [];
  const warnings: string[] = [];
  const candidates: SearchCandidate[] = [];
  const sources: DeterministicResearchSource[] = [];
  const seenCandidates = new Set<string>();
  const visitedUrls = new Set<string>();
  let visibleSearchTabId: number | undefined;
  let googleSearchUrl = "";
  let visibleMs = 0;
  let backgroundMs = 0;
  let visibleVisitCount = 0;
  let consecutiveUnhelpfulVisits = 0;
  let sufficiency = evaluateResearchSufficiency(sources, buildEvidenceCards(sources, intent), intent, "initial candidate acquisition");

  const promptUrlCandidates = rankSearchCandidates(seedCandidatesFromPromptUrls(userMessage), intent, CANDIDATE_BATCH_SIZE);
  if (promptUrlCandidates.length) {
    audit.push({
      label: "Candidate acquisition",
      status: "completed",
      summary: `${promptUrlCandidates.length} prompt URL candidate(s).`
    });
    candidates.push(...promptUrlCandidates);
    markCandidatesSeen(promptUrlCandidates, seenCandidates);
    const batchResult = await extractCandidateBatch({
      batch: promptUrlCandidates,
	      rankOffset: 0,
	      tabId: visibleSearchTabId,
	      intent,
	      visitedUrls,
	      onProgress
	    });
    visibleSearchTabId = batchResult.tabId;
    visibleVisitCount += batchResult.visibleVisits;
    visibleMs += batchResult.visibleMs;
    backgroundMs += batchResult.backgroundMs;
    sources.push(...batchResult.sources);
    audit.push(...batchResult.audit);
    warnings.push(...batchResult.warnings);
    sufficiency = evaluateResearchSufficiency(sources, buildEvidenceCards(sources, intent), intent, "expand from prompt URL pages");
  }

  if (sufficiency.status !== "sufficient" && visibleVisitCount < MAX_VISIBLE_VISITS_SAFETY) {
    const plans = buildSearchPlans(searchQuery, intent);
    for (const plan of plans) {
      if (sufficiency.status === "sufficient" || visibleVisitCount >= MAX_VISIBLE_VISITS_SAFETY) {
        break;
      }

      const lookup = await findTopSearchCandidates(
        plan.query,
        intent,
        visibleSearchTabId,
        plan.start,
        GOOGLE_RESULT_POOL_SIZE
      );
      visibleSearchTabId = lookup.visibleSearchTabId ?? visibleSearchTabId;
      googleSearchUrl ||= lookup.googleSearchUrl;
      audit.push(...lookup.audit);
      emitProgress(onProgress, {
        level: lookup.candidates.length ? "info" : "warning",
        label: "Google",
        detail: `${plan.label}: ${lookup.candidates.length} candidate link(s)`,
        status: lookup.candidates.length ? "completed" : "partial",
        url: lookup.googleSearchUrl
      });
      audit.push({
        label: "Search expansion",
        status: lookup.candidates.length ? "completed" : "partial",
        summary: `${plan.label}: ${lookup.candidates.length} candidate link(s) from ${lookup.googleSearchUrl}.`,
        warning: lookup.warnings[0]
      });
      warnings.push(...lookup.warnings);

      const rankedNewCandidates = rankSearchCandidates(lookup.candidates, intent, GOOGLE_RESULT_POOL_SIZE)
        .filter((candidate) => !seenCandidates.has(normalizeForDedupe(candidate.url)));
      if (!rankedNewCandidates.length) {
        sufficiency = evaluateResearchSufficiency(sources, buildEvidenceCards(sources, intent), intent, "no new result links from search expansion");
        continue;
      }

      for (let index = 0; index < rankedNewCandidates.length; index += CANDIDATE_BATCH_SIZE) {
        if (sufficiency.status === "sufficient" || visibleVisitCount >= MAX_VISIBLE_VISITS_SAFETY) {
          break;
        }
        if (consecutiveUnhelpfulVisits >= MAX_CONSECUTIVE_UNHELPFUL_VISITS_SAFETY) {
          warnings.push(`Stopped deterministic expansion after ${consecutiveUnhelpfulVisits} consecutive visible visits without a new usable source.`);
          emitProgress(onProgress, {
            level: "warning",
            label: "Safety",
            detail: `${consecutiveUnhelpfulVisits} consecutive visible visits produced no new usable source.`,
            status: "partial"
          });
          break;
        }

        const batch = rankedNewCandidates.slice(index, index + CANDIDATE_BATCH_SIZE);
        markCandidatesSeen(batch, seenCandidates);
        candidates.push(...batch);
        const usableBefore = countUsableSources(sources, intent);
        const batchResult = await extractCandidateBatch({
          batch,
	          rankOffset: candidates.length - batch.length,
	          tabId: visibleSearchTabId,
	          intent,
	          visitedUrls,
	          onProgress
	        });
        visibleSearchTabId = batchResult.tabId;
        visibleVisitCount += batchResult.visibleVisits;
        visibleMs += batchResult.visibleMs;
        backgroundMs += batchResult.backgroundMs;
        sources.push(...dedupeSourcesByUrl(batchResult.sources, sources));
        audit.push(...batchResult.audit);
        warnings.push(...batchResult.warnings);

        const usableAfter = countUsableSources(sources, intent);
        consecutiveUnhelpfulVisits = usableAfter > usableBefore
          ? 0
          : consecutiveUnhelpfulVisits + batchResult.visibleVisits;
        sufficiency = evaluateResearchSufficiency(
          sources,
          buildEvidenceCards(sources, intent),
          intent,
          "continue deterministic search expansion"
        );
        emitProgress(onProgress, {
          level: sufficiency.status === "sufficient" ? "info" : "debug",
          label: "Coverage",
          detail: `${sufficiency.coverageScore}/100 coverage, ${sufficiency.usableSourceCount} source(s), ${sufficiency.relevantPassageCount} passage(s)`,
          status: sufficiency.status === "sufficient" ? "completed" : "running"
        });
      }
    }
  }

  if (!candidates.length) {
    warnings.push("No search result links were extracted.");
  }

  if (sufficiency.status !== "sufficient") {
    const nextAction = visibleVisitCount >= MAX_VISIBLE_VISITS_SAFETY
      ? `visible visit safety guard reached at ${visibleVisitCount} visit(s)`
      : consecutiveUnhelpfulVisits >= MAX_CONSECUTIVE_UNHELPFUL_VISITS_SAFETY
        ? `${consecutiveUnhelpfulVisits} consecutive visible visits produced no new usable source`
        : "all deterministic query variants and result pages were exhausted";
    sufficiency = {
      ...evaluateResearchSufficiency(sources, buildEvidenceCards(sources, intent), intent, nextAction),
      status: "exhausted"
    };
  }

  return {
    candidates: uniqueCandidates(candidates),
    sources,
    sufficiency,
    googleSearchUrl,
    audit,
    warnings,
    visibleMs,
    backgroundMs
  };
}

async function extractCandidateBatch(args: {
  batch: SearchCandidate[];
  rankOffset: number;
  tabId?: number;
  intent: SearchIntent;
  visitedUrls: Set<string>;
  onProgress?: (event: RunProgressEvent) => void;
}): Promise<{
  sources: DeterministicResearchSource[];
  tabId?: number;
  visibleVisits: number;
  visibleMs: number;
  backgroundMs: number;
  audit: DeterministicResearchAuditEntry[];
  warnings: string[];
}> {
  const audit: DeterministicResearchAuditEntry[] = [];
  const warnings: string[] = [];
  const visibleStarted = Date.now();
  const remainingVisibleVisits = Math.max(0, MAX_VISIBLE_VISITS_SAFETY - args.visitedUrls.size);
  const visibleRotation = remainingVisibleVisits
    ? await extractVisibleRotatingSources(
        args.batch,
        args.tabId,
	        args.intent,
	        args.visitedUrls,
	        args.rankOffset,
	        remainingVisibleVisits,
	        args.onProgress
	      )
    : { sources: [] as DeterministicResearchSource[], visits: [] as DeterministicResearchSource[], tabId: args.tabId };
  const visibleMs = Date.now() - visibleStarted;

  const fallbackCandidates = args.batch
    .map((candidate, index) => ({
      candidate,
      rank: args.rankOffset + index + 1,
      visibleSource: visibleRotation.sources.find((source) => source.rank === args.rankOffset + index + 1)
    }))
    .filter((item) => !item.visibleSource || !isUsableResearchSource(item.visibleSource, args.intent));

  const backgroundStarted = Date.now();
  const backgroundSources = await Promise.all(
    fallbackCandidates.map((item) => extractBackgroundFetchSource(item.candidate, item.rank))
  );
  const backgroundMs = Date.now() - backgroundStarted;
  const sources = mergeVisibleAndFallbackSources(visibleRotation.sources, backgroundSources, args.intent);

  audit.push({
    label: "Visible rotation",
    status: visibleRotation.sources.some((source) => isUsableResearchSource(source, args.intent)) ? "completed" : "partial",
    summary: `${visibleRotation.sources.filter((source) => isUsableResearchSource(source, args.intent)).length}/${args.batch.length} candidate(s) extracted through one visible rotating tab (${visibleRotation.visits.length} visible visit(s), ${visibleMs}ms).`,
    warning: visibleAttemptWarning(visibleRotation.visits)
  });
  audit.push({
    label: "Background fallback",
    status: backgroundSources.length
      ? backgroundSources.some((source) => source.status === "failed") ? "partial" : "completed"
      : "skipped",
    summary: backgroundSources.length
      ? `${backgroundSources.filter((source) => source.text).length}/${backgroundSources.length} fallback source(s) extracted (${backgroundMs}ms).`
      : "No background fallback needed; visible rotation produced usable sources.",
    warning: backgroundSources.find((source) => source.error)?.error
  });
  warnings.push(...sources.filter((source) => source.error).map((source) => `${source.domain ?? source.url}: ${source.error}`));

  return {
    sources,
    tabId: visibleRotation.tabId,
    visibleVisits: visibleRotation.visits.length,
    visibleMs,
    backgroundMs,
    audit,
    warnings
  };
}

function compileSearchQuery(userMessage: string): string {
  const text = userMessage
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const quotedPhrases = Array.from(text.matchAll(/"([^"]{3,160})"|`([^`]{3,160})`|'([^']{3,160})'/g))
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter(Boolean)
    .map((phrase) => `"${phrase.replace(/\s+/g, " ").trim()}"`);
  const withoutQuotes = text.replace(/"[^"]+"|`[^`]+`|'[^']+'/g, " ");
  const tokens = withoutQuotes.match(/[a-z0-9][a-z0-9._:/#@+-]*/gi) ?? [];
  const usefulTokens: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (isQueryFillerToken(normalized, text) || normalized.length < 2 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    usefulTokens.push(token);
    if (usefulTokens.length >= 14) {
      break;
    }
  }

  if (needsFreshness(text) && !seen.has("latest")) {
    usefulTokens.push("latest");
  }

  if (isArchitectureQuestion(text)) {
    for (const term of ["architecture", "best", "practices"]) {
      if (!seen.has(term)) {
        usefulTokens.push(term);
        seen.add(term);
      }
    }
  }

  const currentYear = String(new Date().getFullYear());
  if (needsFreshness(text) && !seen.has(currentYear)) {
    usefulTokens.push(currentYear);
  }

  const query = [...quotedPhrases, ...usefulTokens].join(" ").trim();
  return query || text || userMessage.trim();
}

function isQueryFillerToken(token: string, text: string): boolean {
  if (STOP_WORDS.has(token) || QUERY_FILLER_WORDS.has(token)) {
    return true;
  }

  if (token === "make") {
    return /\bmake\b[\s\S]{0,80}\b(deterministic|reliable|accurate|faster|better|optimal|work|works|working)\b/i.test(text);
  }

  return false;
}

function isArchitectureQuestion(text: string): boolean {
  return /\b(optimal|best|recommended|how to|way to|ways to|build|building|design|architecture|process|processes|pipeline|pipelines|implement|implementation)\b/i.test(text);
}

function buildEvidenceCards(
  sources: DeterministicResearchSource[],
  intent: SearchIntent
): DeterministicEvidenceCard[] {
  return sources.map((source) => {
    const cleanedText = cleanPageTextForEvidence(source.text);
    const passages = selectRelevantPassages(cleanedText, intent, MAX_EVIDENCE_CARD_PASSAGES);
    const facts = extractCompactFacts({
      source,
      passages,
      cleanedText,
      intent
    });
    const status = determineCardStatus(source, passages);

    return {
      rank: source.rank,
      url: source.url,
      title: clip(source.title || source.domain || source.url, 140),
      domain: source.domain,
      status,
      reasonSelected: reasonSelected(source, intent),
      relevantPassages: passages.map((passage) => clip(passage, MAX_EVIDENCE_PASSAGE_CHARS)),
      extractedFacts: facts.slice(0, MAX_EVIDENCE_FACTS),
      publishedDate: extractPublishedDate(source, cleanedText),
      warning: source.error ? clip(source.error, 180) : undefined
    };
  });
}

function cleanPageTextForEvidence(text: string): string {
  const seen = new Set<string>();
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 25)
    .filter((line) => !BOILERPLATE_LINE_PATTERN.test(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

  return lines.join("\n\n");
}

function selectRelevantPassages(
  cleanedText: string,
  intent: SearchIntent,
  maxPassages: number
): string[] {
  const paragraphs = cleanedText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 50)
    .slice(0, 120);
  const scored = paragraphs
    .map((paragraph, index) => ({
      paragraph,
      index,
      score: scorePassage(paragraph, intent, index)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxPassages)
    .sort((a, b) => a.index - b.index);

  if (scored.length) {
    return scored.map((item) => item.paragraph);
  }

  return paragraphs.slice(0, Math.min(maxPassages, 1));
}

function scorePassage(passage: string, intent: SearchIntent, index: number): number {
  const lower = passage.toLowerCase();
  let score = index < 4 ? 2 : 0;

  for (const term of intent.terms) {
    if (lower.includes(term)) {
      score += 4;
    }
  }

  for (const domain of intent.namedDomains) {
    const siteName = domain.split(".")[0];
    if (lower.includes(siteName)) {
      score += 6;
    }
  }

  if (intent.freshness && /\b(today|now|current|latest|updated|published|posted|202[0-9])\b/i.test(passage)) {
    score += 5;
  }

  if (/\$[\d,.]+|\b\d+(?:\.\d+)?\s?(?:%|tokens?|users?|posts?|comments?|hours?|days?|months?|years?)\b/i.test(passage)) {
    score += 3;
  }

  if (BOILERPLATE_LINE_PATTERN.test(passage)) {
    score -= 10;
  }

  return score;
}

function extractCompactFacts(args: {
  source: DeterministicResearchSource;
  passages: string[];
  cleanedText: string;
  intent: SearchIntent;
}): string[] {
  const factCandidates = [
    args.source.description,
    args.source.snippet,
    ...args.passages.flatMap((passage) => splitSentences(passage))
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 25)
    .filter((value) => value.length <= 280);
  const scored = factCandidates
    .map((fact, index) => ({
      fact,
      index,
      score: scoreFact(fact, args.intent)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return uniqueStrings(scored.map((item) => clip(item.fact, 220))).slice(0, MAX_EVIDENCE_FACTS);
}

function scoreFact(fact: string, intent: SearchIntent): number {
  const lower = fact.toLowerCase();
  let score = 0;

  for (const term of intent.terms) {
    if (lower.includes(term)) {
      score += 2;
    }
  }

  if (/\$[\d,.]+|\b\d+(?:\.\d+)?\s?(?:%|tokens?|users?|posts?|comments?|hours?|days?|months?|years?)\b/i.test(fact)) {
    score += 4;
  }

  if (intent.freshness && /\b(today|now|current|latest|updated|published|posted|202[0-9])\b/i.test(fact)) {
    score += 3;
  }

  return score;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function determineCardStatus(
  source: DeterministicResearchSource,
  passages: string[]
): DeterministicEvidenceCard["status"] {
  if (source.error && /captcha|verify|verification|blocked|access denied|forbidden|login|sign in/i.test(source.error)) {
    return "blocked";
  }

  if (source.status === "failed") {
    return "failed";
  }

  if (!passages.length) {
    return "thin";
  }

  return "ok";
}

function reasonSelected(source: DeterministicResearchSource, intent: SearchIntent): string {
  const domain = source.domain ?? domainFromUrl(source.url) ?? "";
  const matchedDomain = intent.namedDomains.find((targetDomain) => domainMatches(domain, targetDomain));
  if (matchedDomain) {
    return `matched named site/domain ${matchedDomain}`;
  }

  const matchedTerms = intent.terms.filter((term) =>
    `${source.title} ${source.url} ${source.snippet ?? ""}`.toLowerCase().includes(term)
  );
  if (matchedTerms.length) {
    return `matched prompt terms: ${matchedTerms.slice(0, 4).join(", ")}`;
  }

  return `ranked search candidate ${source.rank}`;
}

function extractPublishedDate(source: DeterministicResearchSource, cleanedText: string): string | undefined {
  const haystack = `${source.description ?? ""}\n${cleanedText.slice(0, 1000)}`;
  return haystack.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i)?.[0] ??
    haystack.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ??
    haystack.match(/\b(?:today|yesterday)\b/i)?.[0];
}

function buildSearchIntent(userMessage: string, query: string): SearchIntent {
  const prompt = userMessage.trim();
  const socialDiscussion = hasSocialDiscussionIntent(prompt);
  const video = hasExplicitVideoIntent(prompt);
  const architecture = isArchitectureQuestion(prompt) ||
    /\b(deterministic|reliable|repeatable|reproducible)\b/i.test(prompt) &&
      /\b(search|browser|web|pipeline|process|automation|crawler|scraper|retrieval|extraction)\b/i.test(prompt);
  const terms = uniqueStrings([
    ...extractSearchTerms(prompt),
    ...extractSearchTerms(query)
  ])
    .filter((term) => video || !VIDEO_INTENT_TERMS.has(term))
    .slice(0, 24);
  const explicitDomains = extractExplicitDomains(prompt);
  const aliasMatches = SITE_ALIASES.filter((alias) =>
    alias.patterns.some((pattern) => pattern.test(prompt))
  );
  const namedDomains = uniqueStrings([
    ...explicitDomains,
    ...aliasMatches.map((alias) => alias.domain)
  ]);
  const namedSiteNames = uniqueStrings([
    ...namedDomains.map((domain) => domain.split(".")[0]),
    ...aliasMatches.flatMap((alias) => alias.names)
  ]);

  return {
    prompt,
    query,
    terms,
    namedDomains,
	    namedSiteNames,
	    freshness: needsFreshness(prompt) || needsFreshness(query) || socialDiscussion,
	    architecture,
	    socialDiscussion,
	    video
	  };
}

function hasNamedSiteIntent(value: string): boolean {
  return extractExplicitDomains(value).length > 0 ||
    SITE_ALIASES.some((alias) => alias.patterns.some((pattern) => pattern.test(value)));
}

function hasSocialDiscussionIntent(value: string): boolean {
  return /\b(users?|people|developers?|devs?|community|reddit|forum|forums|comments?|posts?|threads?|discussion|discussing|saying|sentiment|reviews?|reactions?)\b/i.test(value) &&
    /\b(saying|think|thinking|feel|feeling|reacting|reaction|sentiment|reviews?|comments?|posts?|threads?|discussion|about|on)\b/i.test(value);
}

function hasExplicitVideoIntent(value: string): boolean {
  return /\b(video|videos|youtube|youtu\.be|watch|transcript|transcripts|clip|clips|webinar|talk|lecture|presentation|demo)\b/i.test(value);
}

function hasExplicitResearchIntent(value: string): boolean {
  return /\b(search|google|look up|lookup|find online|browse|web|internet|verify|source|sources|cite|latest|current|recent|today|now|news|price|pricing|availability|release|changelog|docs|documentation|api|compare|review)\b/.test(value);
}

function isLikelyResearchableKnowledgePrompt(value: string): boolean {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (!text || isConversationalOrPersonalPrompt(lower) || hasNonResearchCreationIntent(lower)) {
    return false;
  }

  const terms = extractSearchTerms(text).filter((term) => !QUERY_FILLER_WORDS.has(term));
  const hasKnowledgeQuestion = /\b(?:what|who|where|when|why|how)\s+(?:is|are|was|were|does|do|did|can|should|would|to)\b/i.test(text) ||
    /\b(?:explain|define|describe|tell me about|overview of|information about|question about|learn about)\b/i.test(text);
  const hasTopicMarker = hasTechnicalTopicMarker(text);

  if (hasKnowledgeQuestion && hasTopicMarker && terms.length >= 1) {
    return true;
  }

  if (hasKnowledgeQuestion && terms.length >= 3) {
    return true;
  }

  return hasTopicMarker && terms.length >= 2 && looksLikeBareTopicPrompt(text);
}

function hasTechnicalTopicMarker(value: string): boolean {
  return /\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)*\b/.test(value) ||
    /\b(?:agent|agents|automation|browser|crawler|deterministic|framework|library|llm|model|models|pipeline|protocol|retrieval|sdk|scraper|tool|tools|workflow)\b/i.test(value) ||
    /[a-z]+[A-Z][A-Za-z0-9]*|[a-z0-9]+[._/-][a-z0-9._/-]+/.test(value);
}

function looksLikeBareTopicPrompt(value: string): boolean {
  const words = value
    .replace(/[^\w\s.+/#-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 2 &&
    words.length <= 12 &&
    !/[?!.,:;]$/.test(value.trim()) &&
    !/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no)\b/i.test(value);
}

function isConversationalOrPersonalPrompt(value: string): boolean {
  return /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|lol)\b/.test(value) ||
    /\b(?:how are you|what can you do|who are you|your name|my favorite|my password|my account|this conversation|this chat)\b/.test(value);
}

function hasNonResearchCreationIntent(value: string): boolean {
  return /\b(?:write|draft|compose|generate|rewrite|translate|proofread|summarize|format)\b/.test(value) &&
    !/\b(?:research|source|sources|cite|cites|citation|citations|fact|facts|factual|explain|define|overview|information)\b/.test(value);
}

function extractSearchTerms(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._+-]{2,}/g)
    ?.map((term) => term.replace(/^www\./, ""))
    .filter((term) => !STOP_WORDS.has(term) && !COMMON_TLDS.has(term))
    .slice(0, 32) ?? [];
}

function extractExplicitDomains(value: string): string[] {
  const domains: string[] = [];
  const pattern = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(com|org|net|io|dev|ai|app|co|edu|gov|info|me|tv|news|social|site))\b/gi;
  for (const match of value.matchAll(pattern)) {
    domains.push(match[1].toLowerCase());
  }

  return uniqueStrings(domains);
}

function seedCandidatesFromIntent(intent: SearchIntent): SearchCandidate[] {
  return intent.namedDomains.map((domain) => ({
    id: makeId("candidate"),
    title: domain,
    url: `https://${domain}/`,
    domain
  }));
}

function seedCandidatesFromPromptUrls(userMessage: string): SearchCandidate[] {
  const urls = userMessage.match(/https?:\/\/[^\s<>)"']+/gi) ?? [];
  return uniqueStrings(urls).slice(0, CANDIDATE_BATCH_SIZE).map((url) => ({
    id: makeId("candidate"),
    title: domainFromUrl(url) ?? url,
    url,
    domain: domainFromUrl(url)
  }));
}

function rankSearchCandidates(
  candidates: SearchCandidate[],
  intent: SearchIntent,
  limit = GOOGLE_RESULT_POOL_SIZE
): SearchCandidate[] {
  const scored = candidates
    .map((candidate, index): ScoredCandidate => ({
      candidate,
      score: scoreCandidate(candidate, intent, index),
      index
    }))
    .filter((item) => intent.video || !isVideoCandidate(item.candidate))
    .filter((item) => item.score > -80)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return selectDiverseCandidates(scored, intent, limit).map((item) => item.candidate);
}

function scoreCandidate(candidate: SearchCandidate, intent: SearchIntent, index: number): number {
  const url = safeUrl(candidate.url);
  const domain = url ? normalizedHostname(url) : candidate.domain ?? "";
  const haystack = `${candidate.title} ${candidate.snippet ?? ""} ${candidate.url}`.toLowerCase();
  let score = 30 - Math.min(index, 40) * 0.25;

  for (const term of intent.terms) {
    if (candidate.title.toLowerCase().includes(term)) {
      score += 7;
    }
    if ((candidate.snippet ?? "").toLowerCase().includes(term)) {
      score += 4;
    }
    if (candidate.url.toLowerCase().includes(term)) {
      score += 5;
    }
    if (domain.includes(term)) {
      score += 12;
    }
  }

  for (const siteName of intent.namedSiteNames) {
    if (siteName && haystack.includes(siteName)) {
      score += 28;
    }
  }

  if (intent.namedDomains.length) {
    const matchesNamedDomain = intent.namedDomains.some((targetDomain) => domainMatches(domain, targetDomain));
    score += matchesNamedDomain ? 90 : -35;
  }

  if (intent.freshness && /\b(latest|current|today|now|live|news|202[0-9])\b/i.test(haystack)) {
    score += 8;
  }

  score += sourceClassAdjustment(candidate, intent);
  score -= utilityPenalty(candidate, intent);

  if (/\b(sign in|login|verify|verification|captcha|blocked|access denied)\b/i.test(haystack)) {
    score -= 25;
  }

  if (!candidate.title || candidate.title === candidate.url) {
    score -= 4;
  }

  return score;
}

function sourceClassAdjustment(candidate: SearchCandidate, intent: SearchIntent): number {
  const sourceClass = classifySource(candidate);
  const haystack = `${candidate.title} ${candidate.url} ${candidate.snippet ?? ""}`.toLowerCase();
  const requestedSocial = intent.socialDiscussion || intent.namedDomains.some((domain) =>
    ["reddit.com", "x.com", "twitter.com", "news.ycombinator.com"].some((target) => domainMatches(domain, target))
  );

  if (intent.video && sourceClass === "video") {
    return 50;
  }

  if (requestedSocial && (sourceClass === "social" || sourceClass === "forum")) {
    return 55;
  }

  if (intent.architecture) {
    if (sourceClass === "docs" || sourceClass === "research") {
      return 35;
    }
    if (sourceClass === "article" || sourceClass === "blog" || sourceClass === "code") {
      return 25;
    }
    if (sourceClass === "forum") {
      return -10;
    }
    if (sourceClass === "social") {
      return -35;
    }
    if (sourceClass === "video") {
      return -65;
    }
  }

  if (sourceClass === "docs" || sourceClass === "official" || sourceClass === "research") {
    return 18;
  }
  if (sourceClass === "article" || sourceClass === "blog" || sourceClass === "code") {
    return 12;
  }
  if (sourceClass === "video") {
    return intent.video ? 12 : -120;
  }
  if (sourceClass === "social") {
    return requestedSocial ? 30 : -25;
  }
  if (sourceClass === "forum") {
    return requestedSocial ? 25 : -8;
  }

  return 0;
}

function classifySource(candidate: SearchCandidate): SourceClass {
  const url = safeUrl(candidate.url);
  const host = url ? normalizedHostname(url) : (candidate.domain ?? "").toLowerCase().replace(/^www\./, "");
  const path = url?.pathname.toLowerCase() ?? "";
  const haystack = `${candidate.title} ${candidate.url} ${candidate.snippet ?? ""}`.toLowerCase();

  if (host.includes("youtube.com") || host === "youtu.be" || host.includes("vimeo.com")) {
    return "video";
  }
  if (host.includes("reddit.com") || host === "x.com" || host.includes("twitter.com") || host.includes("instagram.com") || host.includes("tiktok.com")) {
    return "social";
  }
  if (host.includes("stackoverflow.com") || host.includes("stackexchange.com") || host.includes("news.ycombinator.com") || host.includes("forum")) {
    return "forum";
  }
  if (host.includes("github.com") || host.includes("gitlab.com") || host.includes("bitbucket.org")) {
    return "code";
  }
  if (host.includes("arxiv.org") || host.includes("doi.org") || host.includes("acm.org") || host.includes("ieee.org") || host.includes("semanticscholar.org")) {
    return "research";
  }
  if (path.includes("/docs") || path.includes("/documentation") || host.startsWith("docs.") || haystack.includes("documentation")) {
    return "docs";
  }
  if (host.includes("medium.com") || host.includes("substack.com") || host.startsWith("blog.") || path.includes("/blog") || haystack.includes("blog")) {
    return "blog";
  }
  if (/\b(guide|tutorial|architecture|best practices|engineering|explained|how to)\b/.test(haystack)) {
    return "article";
  }
  if (path === "/" || path === "") {
    return "official";
  }

  return "generic";
}

function isVideoCandidate(candidate: SearchCandidate): boolean {
  if (classifySource(candidate) === "video") {
    return true;
  }

  const url = safeUrl(candidate.url);
  const path = url?.pathname.toLowerCase() ?? "";
  const haystack = `${candidate.title} ${candidate.url} ${candidate.snippet ?? ""}`.toLowerCase();
  return /\b(youtube|youtu\.be|vimeo|watch video|video result|videos? -|webinar|full video|clip|clips)\b/i.test(haystack) ||
    /\/(watch|videos?|shorts|embed)\b/.test(path);
}

function selectDiverseCandidates(
  scored: ScoredCandidate[],
  intent: SearchIntent,
  limit: number
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const domainCounts = new Map<string, number>();

  for (const item of scored) {
    const domain = domainFromUrl(item.candidate.url) ?? item.candidate.domain ?? item.candidate.url;
    const domainIsNamed = intent.namedDomains.some((targetDomain) => domainMatches(domain, targetDomain));
    const sourceClass = classifySource(item.candidate);
    const cap = domainIsNamed ? limit : intent.architecture && (sourceClass === "video" || sourceClass === "social") ? 1 : 2;
    const count = domainCounts.get(domain) ?? 0;
    if (count >= cap) {
      continue;
    }

    selected.push(item);
    domainCounts.set(domain, count + 1);
    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const item of scored) {
    if (selected.includes(item)) {
      continue;
    }

    selected.push(item);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

async function findTopSearchCandidates(
  query: string,
  intent: SearchIntent,
  reuseTabId?: number,
  start = 0,
  limit = GOOGLE_RESULT_POOL_SIZE
): Promise<CandidateLookup> {
  const googleSearchUrl = makeGoogleSearchUrl(query, start);
  const warnings: string[] = [];
  const audit: DeterministicResearchAuditEntry[] = [];
  const visibleSearchPromise = openVisibleSearchPage(googleSearchUrl, reuseTabId);
  const backgroundGrabPromise = collectBackgroundSearchCandidates(googleSearchUrl);

  const [visibleSearch, backgroundGrab] = await Promise.all([
    visibleSearchPromise.catch((error) => ({
      visibleSearchTabId: undefined,
      warning: error instanceof Error ? error.message : "Visible search page failed to open."
    })),
    backgroundGrabPromise
  ]);
  let visibleSearchTabId = visibleSearch.visibleSearchTabId;
  let visibleCandidates: SearchCandidate[] = [];
  audit.push(backgroundGrab.audit);
  audit.push({
    label: "Visible search",
    status: visibleSearchTabId === undefined ? "failed" : "completed",
    summary: `Tab ${visibleSearchTabId ?? "?"}: opened visible search results page.`,
    warning: visibleSearch.warning
  });

  if (visibleSearch.warning) {
    warnings.push(visibleSearch.warning);
  }

  if (
    visibleSearchTabId !== undefined &&
    backgroundGrab.candidates.length < Math.min(MIN_SEARCH_PROVIDER_CANDIDATES, GOOGLE_RESULT_POOL_SIZE)
  ) {
    const visibleGrab = await collectCandidatesFromVisibleSearchTab(visibleSearchTabId).catch((error) => ({
      candidates: [] as SearchCandidate[],
      warning: error instanceof Error ? error.message : "Visible URL scrape failed."
    }));
    visibleCandidates = visibleGrab.candidates;
    audit.push({
      label: "Visible URL scrape",
      status: visibleCandidates.length ? "completed" : "partial",
      summary: `Tab ${visibleSearchTabId}: ${visibleCandidates.length} link(s) extracted from loaded search results.`,
      warning: visibleGrab.warning
    });
  }

  const seededCandidates = seedCandidatesFromIntent(intent);
  const candidatePool = mergeCandidates(backgroundGrab.candidates, visibleCandidates, seededCandidates)
    .filter((candidate) => intent.video || !isVideoCandidate(candidate));
  const rankedCandidates = rankSearchCandidates(candidatePool, intent, limit).slice(0, limit);
  if (rankedCandidates.length < Math.min(CANDIDATE_BATCH_SIZE, limit)) {
    warnings.push(
      `Search candidate acquisition produced ${rankedCandidates.length}/${Math.min(CANDIDATE_BATCH_SIZE, limit)} target link(s).`
    );
  }

  return {
    candidates: rankedCandidates,
    googleSearchUrl,
    visibleSearchTabId,
    warnings,
    audit
  };
}

async function collectBackgroundSearchCandidates(
  searchUrl: string
): Promise<{ candidates: SearchCandidate[]; audit: DeterministicResearchAuditEntry }> {
  try {
    const { text } = await fetchTextWithTimeout(searchUrl, SEARCH_TIMEOUT_MS);
    const candidates = parseGoogleResultCandidates(text, GOOGLE_RESULT_POOL_SIZE);
    const blockedReason = candidates.length ? undefined : detectGoogleSearchBlocker(text);
    return {
      candidates,
      audit: {
        label: "Background URL grabber",
        status: candidates.length ? "completed" : "partial",
        summary: `${candidates.length} parseable link(s) from ${searchUrl}.`,
        warning: blockedReason ?? (candidates.length ? undefined : "No parseable result links.")
      }
    };
  } catch (error) {
    return {
      candidates: [],
      audit: {
        label: "Background URL grabber",
        status: "failed",
        summary: `Failed to fetch ${searchUrl}.`,
        warning: error instanceof Error ? error.message : "Background URL grabber failed."
      }
    };
  }
}

async function openVisibleSearchPage(
  searchUrl: string,
  reuseTabId?: number
): Promise<{ visibleSearchTabId?: number; warning?: string }> {
  const tab = reuseTabId === undefined
    ? await chrome.tabs.create({
        url: searchUrl,
        active: true
      })
    : await chrome.tabs.update(reuseTabId, {
        url: searchUrl,
        active: true
      });
  const tabId = requiredTabId(tab);
  await waitForTabComplete(tabId, VISIBLE_TAB_TIMEOUT_MS).catch(() => undefined);
  return {
    visibleSearchTabId: tabId
  };
}

async function collectCandidatesFromVisibleSearchTab(
  tabId: number
): Promise<{ candidates: SearchCandidate[]; warning?: string }> {
  const organicCandidates = candidatesFromVisibleSearchResults(
    await extractGoogleResultCandidates(tabId, GOOGLE_RESULT_POOL_SIZE).catch(() => []),
    GOOGLE_RESULT_POOL_SIZE
  );
  let genericCandidates: SearchCandidate[] = [];
  if (organicCandidates.length < GOOGLE_RESULT_POOL_SIZE) {
    const snapshot = await snapshotTab(tabId, { maxChars: 6000, includeLinks: true });
    genericCandidates = candidatesFromLinks(snapshot.links, GOOGLE_RESULT_POOL_SIZE);
  }
  const candidates = mergeCandidates(organicCandidates, genericCandidates).slice(0, GOOGLE_RESULT_POOL_SIZE);
  const warning = candidates.length
    ? organicCandidates.length
      ? undefined
      : "Organic SERP extractor found no result-heading links; used generic visible links."
    : "Visible URL scrape found no result links.";

  return {
    candidates,
    warning
  };
}

async function extractVisibleRotatingSources(
  candidates: SearchCandidate[],
  reuseTabId: number | undefined,
  intent: SearchIntent,
  visitedUrls: Set<string>,
  rankOffset = 0,
  maxVisibleVisits = MAX_VISIBLE_VISITS_SAFETY,
  onProgress?: (event: RunProgressEvent) => void
): Promise<VisibleRotationResult> {
  let currentTabId = reuseTabId;
  const sources: DeterministicResearchSource[] = [];
  const visits: DeterministicResearchSource[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    if (visits.length >= maxVisibleVisits) {
      break;
    }

    const result = await extractVisibleCandidateSource(
      candidates[index],
      rankOffset + index + 1,
      currentTabId,
	      intent,
	      visitedUrls,
	      maxVisibleVisits - visits.length,
	      onProgress
	    );
    sources.push(result.source);
    visits.push(...result.visits);

    const lastVisibleVisit = [...result.visits].reverse().find((visit) => visit.tabId !== undefined);
    if (lastVisibleVisit?.tabId !== undefined) {
      currentTabId = lastVisibleVisit.tabId;
    }
  }

  return { sources, visits, tabId: currentTabId };
}

async function extractVisibleCandidateSource(
  candidate: SearchCandidate,
  rank: number,
  reuseTabId: number | undefined,
  intent: SearchIntent,
  visitedUrls: Set<string>,
  maxVisibleVisits: number,
  onProgress?: (event: RunProgressEvent) => void
): Promise<VisibleCandidateExtractionResult> {
  const queue: Array<{ candidate: SearchCandidate; depth: number }> = [{ candidate, depth: 0 }];
  const visits: DeterministicResearchSource[] = [];
  let bestSource: DeterministicResearchSource | undefined;
  let currentTabId = reuseTabId;

  while (queue.length && visits.length < maxVisibleVisits) {
    const queued = queue.shift();
    if (!queued) {
      break;
    }

    const dedupeKey = normalizeForDedupe(queued.candidate.url);
    if (visitedUrls.has(dedupeKey)) {
      continue;
    }
    visitedUrls.add(dedupeKey);

    emitProgress(onProgress, {
      level: queued.depth ? "debug" : "info",
      label: queued.depth ? "Deep page" : "Visit",
      detail: `${rank}. ${queued.candidate.title || domainFromUrl(queued.candidate.url) || queued.candidate.url}`,
      status: "running",
      url: queued.candidate.url
    });
    const visit = await navigateVisibleCandidateSource(queued.candidate, rank, currentTabId);
    visits.push(visit.source);
    visitedUrls.add(normalizeForDedupe(visit.source.url));
    if (visit.source.tabId !== undefined) {
      currentTabId = visit.source.tabId;
    }
    if (!bestSource || scoreSourceCompleteness(visit.source, intent) > scoreSourceCompleteness(bestSource, intent)) {
      bestSource = visit.source;
    }
    emitProgress(onProgress, {
      level: isUsableResearchSource(visit.source, intent) ? "info" : visit.source.status === "failed" ? "warning" : "debug",
      label: isUsableResearchSource(visit.source, intent) ? "Accepted" : visit.source.status === "failed" ? "Blocked" : "Thin",
      detail: `${visit.source.title || visit.source.url} (${cleanPageTextForEvidence(visit.source.text).length} chars)`,
      status: isUsableResearchSource(visit.source, intent) ? "completed" : "partial",
      url: visit.source.url
    });

    if (
      visit.snapshot &&
      queued.depth < MAX_INTERNAL_DEPTH_SAFETY &&
      visits.length < Math.min(maxVisibleVisits, MAX_INTERNAL_VISITS_PER_CANDIDATE_SAFETY + 1) &&
      shouldTryInternalDeepening(visit.source, visit.snapshot, intent)
    ) {
      const remainingInternalVisits = Math.min(
        maxVisibleVisits - visits.length,
        MAX_INTERNAL_VISITS_PER_CANDIDATE_SAFETY + 1 - visits.length
      );
      const internalLinks = selectDeterministicInternalLinks(
        visit.snapshot,
        queued.candidate,
        intent,
        visitedUrls,
        remainingInternalVisits
      );
      if (internalLinks.length) {
        emitProgress(onProgress, {
          level: "debug",
          label: "Deepen",
          detail: `${internalLinks.length} same-site link(s) queued from ${visit.source.domain ?? domainFromUrl(visit.source.url) ?? "page"}.`,
          status: "running",
          url: visit.source.url
        });
      }
      queue.push(...internalLinks.map((link) => ({
        candidate: {
          ...queued.candidate,
          title: link.text || queued.candidate.title,
          url: link.url,
          domain: domainFromUrl(link.url)
        },
        depth: queued.depth + 1
      })));
    }
  }

  return {
    source: bestSource ?? {
      rank,
      url: candidate.url,
      title: candidate.title || domainFromUrl(candidate.url) || candidate.url,
      domain: domainFromUrl(candidate.url),
      snippet: candidate.snippet,
      headings: [],
      text: "",
      status: "failed",
      extractionMethod: "visible_tab",
      tabId: currentTabId,
      error: "No unvisited URL remained for this candidate.",
      elapsedMs: 0
    },
    visits
  };
}

async function navigateVisibleCandidateSource(
  candidate: SearchCandidate,
  rank: number,
  reuseTabId?: number
): Promise<{ source: DeterministicResearchSource; snapshot?: PageSnapshot }> {
  const started = Date.now();
  let tab: chrome.tabs.Tab | undefined;

  try {
    const url = normalizeHttpUrl(candidate.url);
    tab = reuseTabId === undefined
      ? await chrome.tabs.create({ url, active: true })
      : await chrome.tabs.update(reuseTabId, { url, active: true });
    const tabId = requiredTabId(tab);
    await waitForTabComplete(tabId, VISIBLE_TAB_TIMEOUT_MS).catch(() => undefined);
    const refreshed = await chrome.tabs.get(tabId).catch(() => tab);
    const snapshot = await waitForExtractableSnapshot(tabId, {
      maxChars: MAX_VISIBLE_TEXT_CHARS,
      includeLinks: true,
      timeoutMs: EXTRACTABLE_CONTENT_TIMEOUT_MS
    });

    return {
      source: sourceFromSnapshot({
        candidate,
        rank,
        snapshot,
        tabId,
        extractionMethod: "visible_tab",
        elapsedMs: Date.now() - started,
        fallbackTitle: refreshed?.title
      }),
      snapshot
    };
  } catch (error) {
    return {
      source: {
        rank,
        url: candidate.url,
        title: candidate.title || domainFromUrl(candidate.url) || candidate.url,
        domain: domainFromUrl(candidate.url),
        snippet: candidate.snippet,
        headings: [],
        text: "",
        status: "failed",
        extractionMethod: "visible_tab",
        tabId: tab?.id,
        error: error instanceof Error ? error.message : "Visible rotating tab extraction failed.",
        elapsedMs: Date.now() - started
      }
    };
  }
}

function isUsableResearchSource(source: DeterministicResearchSource, intent?: SearchIntent): boolean {
  const cleanedText = cleanPageTextForEvidence(source.text);
  if (source.status === "failed" || cleanedText.length < MIN_EXTRACTABLE_TEXT_CHARS) {
    return false;
  }

  if (!intent) {
    return true;
  }

  return scoreSourceCompleteness(source, intent) >= 30;
}

function shouldTryInternalDeepening(
  source: DeterministicResearchSource,
  snapshot: PageSnapshot,
  intent: SearchIntent
): boolean {
  if (source.status === "failed" || !snapshot.links.length) {
    return false;
  }

  const cleanedText = cleanPageTextForEvidence(source.text);
  const termHits = countTermHits(cleanedText, intent.terms);

  if (cleanedText.length < MIN_EXTRACTABLE_TEXT_CHARS) {
    return true;
  }

  if (isLikelyHomepageUrl(source.url) && termHits < Math.min(2, intent.terms.length)) {
    return true;
  }

  return cleanedText.length < HOMEPAGE_DEEPEN_TEXT_CHARS && termHits < Math.min(3, intent.terms.length);
}

function selectDeterministicInternalLinks(
  snapshot: PageSnapshot,
  candidate: SearchCandidate,
  intent: SearchIntent,
  visitedUrls: Set<string>,
  limit: number
): Array<PageSnapshot["links"][number]> {
  const currentUrl = safeUrl(snapshot.url || candidate.url);
  if (!currentUrl) {
    return [];
  }

  const scored = snapshot.links
    .map((link, index) => {
      const normalizedUrl = normalizeInternalLinkUrl(link.url, currentUrl);
      if (!normalizedUrl) {
        return undefined;
      }

      const parsed = safeUrl(normalizedUrl);
      if (
        !parsed ||
        !isSameSiteUrl(parsed, currentUrl) ||
        normalizeForDedupe(normalizedUrl) === normalizeForDedupe(currentUrl.href) ||
        visitedUrls.has(normalizeForDedupe(normalizedUrl))
      ) {
        return undefined;
      }

      const score = scoreInternalLink({
        linkText: link.text,
        url: parsed,
        intent,
        index
      });
      if (score < INTERNAL_LINK_SCORE_THRESHOLD) {
        return undefined;
      }

      return {
        link: {
          ...link,
          url: normalizedUrl
        },
        score,
        index
      };
    })
    .filter((item): item is { link: PageSnapshot["links"][number]; score: number; index: number } => Boolean(item))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.slice(0, Math.max(0, limit)).map((item) => item.link);
}

function scoreInternalLink(args: {
  linkText: string;
  url: URL;
  intent: SearchIntent;
  index: number;
}): number {
  const linkText = args.linkText.toLowerCase();
  const pathText = decodeUrlText(`${args.url.pathname} ${args.url.search}`)
    .replace(/[-_/=&?]+/g, " ")
    .toLowerCase();
  const haystack = `${linkText} ${pathText}`;

  if (UTILITY_INTERNAL_LINK_PATTERN.test(haystack)) {
    return -100;
  }

  let score = Math.max(0, 8 - args.index * 0.05);
  for (const term of args.intent.terms) {
    if (term.length < 3) {
      continue;
    }

    if (linkText.includes(term)) {
      score += 12;
    }
    if (pathText.includes(term)) {
      score += 8;
    }
  }

  if (args.intent.freshness && /\b(latest|news|updates?|changelog|release|releases|blog|press|announcements?)\b/i.test(haystack)) {
    score += 16;
  }

  if (args.intent.architecture && /\b(docs?|documentation|api|developers?|guides?|learn|architecture|engineering|reference)\b/i.test(haystack)) {
    score += 14;
  }

  if (HIGH_VALUE_INTERNAL_LINK_PATTERN.test(haystack)) {
    score += 10;
  }

  if (args.url.pathname !== "/" && args.url.pathname !== "") {
    score += 4;
  }

  if (/^(learn more|more|read more|details|click here)$/i.test(args.linkText.trim())) {
    score -= 6;
  }

  return score;
}

function evaluateResearchSufficiency(
  sources: DeterministicResearchSource[],
  cards: DeterministicEvidenceCard[],
  intent: SearchIntent,
  nextAction: string
): ResearchSufficiencyReport {
  const usableCards = cards.filter((card) => card.status === "ok");
  const usableSources = sources.filter((source) => isUsableResearchSource(source, intent));
  const diverseDomains = uniqueStrings(usableSources.map((source) => source.domain ?? domainFromUrl(source.url) ?? ""));
  const relevantPassageCount = usableCards.reduce((total, card) => total + card.relevantPassages.length, 0);
  const coverageScore = calculateCoverageScore(usableSources, usableCards, intent);
  const freshnessSatisfied = !intent.freshness || usableCards.some((card) =>
    Boolean(card.publishedDate) ||
    /\b(today|now|current|latest|updated|published|posted|202[0-9])\b/i.test(`${card.title} ${card.extractedFacts.join(" ")} ${card.relevantPassages.join(" ")}`)
  );
  const requiredSourceCount = intent.namedDomains.length ? 1 : MIN_SUFFICIENT_SOURCES;
  const requiredDomainCount = intent.namedDomains.length ? 1 : MIN_SUFFICIENT_DOMAIN_COUNT;
  const requirements = [
    {
      label: "usable sources",
      passed: usableSources.length >= requiredSourceCount,
      summary: `${usableSources.length}/${requiredSourceCount} usable source(s)`
    },
    {
      label: "domain diversity",
      passed: diverseDomains.length >= requiredDomainCount,
      summary: `${diverseDomains.length}/${requiredDomainCount} independent domain(s)`
    },
    {
      label: "passage depth",
      passed: relevantPassageCount >= MIN_SUFFICIENT_PASSAGES,
      summary: `${relevantPassageCount}/${MIN_SUFFICIENT_PASSAGES} relevant passage(s)`
    },
    {
      label: "prompt coverage",
      passed: coverageScore >= MIN_SUFFICIENT_COVERAGE_SCORE,
      summary: `${coverageScore}/${MIN_SUFFICIENT_COVERAGE_SCORE} coverage score`
    },
    {
      label: "freshness",
      passed: freshnessSatisfied,
      summary: intent.freshness ? (freshnessSatisfied ? "freshness signal found" : "freshness signal missing") : "not required"
    }
  ];

  return {
    status: requirements.every((requirement) => requirement.passed) ? "sufficient" : "insufficient",
    coverageScore,
    usableSourceCount: usableSources.length,
    diverseDomainCount: diverseDomains.length,
    relevantPassageCount,
    freshnessSatisfied,
    requirements,
    nextAction: requirements.every((requirement) => requirement.passed) ? undefined : nextAction
  };
}

function calculateCoverageScore(
  sources: DeterministicResearchSource[],
  cards: DeterministicEvidenceCard[],
  intent: SearchIntent
): number {
  const terms = intent.terms.filter((term) => term.length >= 3).slice(0, 16);
  const haystack = [
    ...sources.map((source) => `${source.title} ${source.url} ${source.description ?? ""} ${source.headings.join(" ")} ${cleanPageTextForEvidence(source.text).slice(0, 6000)}`),
    ...cards.map((card) => `${card.title} ${card.extractedFacts.join(" ")} ${card.relevantPassages.join(" ")}`)
  ].join("\n").toLowerCase();
  const termCoverage = terms.length
    ? terms.filter((term) => haystack.includes(term)).length / terms.length
    : 1;
  const sourceScore = Math.min(1, sources.length / MIN_SUFFICIENT_SOURCES);
  const passageScore = Math.min(1, cards.reduce((total, card) => total + card.relevantPassages.length, 0) / MIN_SUFFICIENT_PASSAGES);
  const freshnessScore = !intent.freshness || /\b(today|now|current|latest|updated|published|posted|202[0-9])\b/i.test(haystack) ? 1 : 0;

  return Math.round((termCoverage * 50) + (sourceScore * 20) + (passageScore * 20) + (freshnessScore * 10));
}

function scoreSourceCompleteness(source: DeterministicResearchSource, intent: SearchIntent): number {
  const cleanedText = cleanPageTextForEvidence(source.text);
  if (source.status === "failed" || !cleanedText) {
    return 0;
  }

  const termHits = countTermHits(`${source.title}\n${source.url}\n${source.description ?? ""}\n${source.headings.join("\n")}\n${cleanedText}`, intent.terms);
  let score = Math.min(30, Math.floor(cleanedText.length / 120));
  score += Math.min(30, termHits * 6);
  score += Math.min(20, selectRelevantPassages(cleanedText, intent, 4).length * 5);
  if (intent.freshness && /\b(today|now|current|latest|updated|published|posted|202[0-9])\b/i.test(`${source.title}\n${source.description ?? ""}\n${cleanedText.slice(0, 1500)}`)) {
    score += 12;
  }
  if (source.description) {
    score += 4;
  }
  if (source.headings.length) {
    score += 4;
  }
  if (isLikelyHomepageUrl(source.url) && termHits < 2) {
    score -= 15;
  }

  return score;
}

function buildSearchPlans(searchQuery: string, intent: SearchIntent): SearchPlan[] {
  const queries = uniqueStrings([
    searchQuery,
    intent.architecture ? `${searchQuery} docs guide architecture` : "",
    intent.freshness ? `${searchQuery} latest updated changelog news` : "",
    /\b(api|docs|documentation|developer|developers|sdk|library|framework)\b/i.test(intent.prompt)
      ? `${searchQuery} official documentation API`
      : "",
    intent.socialDiscussion ? `${searchQuery} reddit forum discussion reviews` : "",
    /\b(compare|comparison|versus|vs|review|reviews|best)\b/i.test(intent.prompt)
      ? `${searchQuery} comparison review`
      : ""
  ].map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean));

  return queries.flatMap((query, queryIndex) =>
    Array.from({ length: MAX_SERP_PAGES_PER_QUERY_SAFETY }, (_value, pageIndex): SearchPlan => ({
      query,
      label: queryIndex === 0 && pageIndex === 0
        ? "primary query"
        : `query variant ${queryIndex + 1}, page ${pageIndex + 1}`,
      start: pageIndex * GOOGLE_RESULTS_PER_PAGE
    }))
  );
}

function markCandidatesSeen(candidates: SearchCandidate[], seenCandidates: Set<string>): void {
  for (const candidate of candidates) {
    seenCandidates.add(normalizeForDedupe(candidate.url));
  }
}

function countUsableSources(sources: DeterministicResearchSource[], intent: SearchIntent): number {
  return sources.filter((source) => isUsableResearchSource(source, intent)).length;
}

function dedupeSourcesByUrl(
  nextSources: DeterministicResearchSource[],
  existingSources: DeterministicResearchSource[]
): DeterministicResearchSource[] {
  const seen = new Set(existingSources.map((source) => normalizeForDedupe(source.url)));
  return nextSources.filter((source) => {
    const key = normalizeForDedupe(source.url);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function uniqueCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizeForDedupe(candidate.url);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
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

function mergeVisibleAndFallbackSources(
  visibleSources: DeterministicResearchSource[],
  fallbackSources: DeterministicResearchSource[],
  intent?: SearchIntent
): DeterministicResearchSource[] {
  const fallbackByRank = new Map(fallbackSources.map((source) => [source.rank, source]));
  const merged = visibleSources.map((visibleSource) => {
    const fallbackSource = fallbackByRank.get(visibleSource.rank);
    return fallbackSource && shouldUseFallbackSource(visibleSource, fallbackSource, intent)
      ? fallbackSource
      : visibleSource;
  });
  const visibleRanks = new Set(visibleSources.map((source) => source.rank));

  for (const fallbackSource of fallbackSources) {
    if (!visibleRanks.has(fallbackSource.rank)) {
      merged.push(fallbackSource);
    }
  }

  return merged;
}

function shouldUseFallbackSource(
  visibleSource: DeterministicResearchSource,
  fallbackSource: DeterministicResearchSource,
  intent?: SearchIntent
): boolean {
  if (isUsableResearchSource(fallbackSource, intent)) {
    return !isUsableResearchSource(visibleSource, intent);
  }

  return visibleSource.status === "failed" && fallbackSource.status !== "failed" && Boolean(fallbackSource.text);
}

function countTermHits(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.filter((term) => term.length >= 3 && normalized.includes(term)).length;
}

function isLikelyHomepageUrl(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) {
    return false;
  }

  return parsed.pathname === "/" || parsed.pathname === "";
}

function normalizeInternalLinkUrl(raw: string, baseUrl: URL): string | undefined {
  try {
    const parsed = new URL(raw, baseUrl.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

function decodeUrlText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSameSiteUrl(candidateUrl: URL, currentUrl: URL): boolean {
  const candidateHost = normalizedHostname(candidateUrl);
  const currentHost = normalizedHostname(currentUrl);
  return candidateHost === currentHost ||
    candidateHost.endsWith(`.${currentHost}`) ||
    currentHost.endsWith(`.${candidateHost}`);
}

function visibleAttemptWarning(attempts: DeterministicResearchSource[]): string | undefined {
  const failedAttempts = attempts
    .filter((attempt) => attempt.error)
    .map((attempt) => `${attempt.rank}. ${attempt.domain ?? attempt.url}: ${attempt.error}`);

  return failedAttempts.length ? failedAttempts.join(" | ") : undefined;
}

async function extractBackgroundFetchSource(
  candidate: SearchCandidate,
  rank: number
): Promise<DeterministicResearchSource> {
  const started = Date.now();

  try {
    const { response, text, url } = await fetchTextWithTimeout(candidate.url, BACKGROUND_FETCH_TIMEOUT_MS);
    const contentType = response.headers.get("content-type") ?? "";
    if (!isReadableContentType(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
    }

    const snapshot = snapshotFromFetchedText(url, text, contentType, MAX_BACKGROUND_TEXT_CHARS);
    return {
      ...sourceFromSnapshot({
        candidate,
        rank,
        snapshot,
        extractionMethod: "background_fetch",
        elapsedMs: Date.now() - started
      }),
      httpStatus: response.status
    };
  } catch (error) {
    return {
      rank,
      url: candidate.url,
      title: candidate.title || domainFromUrl(candidate.url) || candidate.url,
      domain: domainFromUrl(candidate.url),
      snippet: candidate.snippet,
      headings: [],
      text: "",
      status: "failed",
      extractionMethod: "background_fetch",
      error: error instanceof Error ? error.message : "Background fetch extraction failed.",
      elapsedMs: Date.now() - started
    };
  }
}

function sourceFromSnapshot(args: {
  candidate: SearchCandidate;
  rank: number;
  snapshot: PageSnapshot;
  extractionMethod: DeterministicResearchSource["extractionMethod"];
  elapsedMs: number;
  tabId?: number;
  fallbackTitle?: string;
}): DeterministicResearchSource {
  const title = args.snapshot.title || args.fallbackTitle || args.candidate.title || domainFromUrl(args.candidate.url) || args.candidate.url;
  const blocker = detectBlockingReason(`${args.snapshot.title}\n${args.snapshot.text}`);
  return {
    rank: args.rank,
    url: args.snapshot.url || args.candidate.url,
    title,
    domain: domainFromUrl(args.snapshot.url || args.candidate.url),
    snippet: args.candidate.snippet,
    description: args.snapshot.description,
    headings: args.snapshot.headings,
    text: args.snapshot.text,
    status: blocker ? "failed" : args.snapshot.text ? "ok" : "partial",
    extractionMethod: args.extractionMethod,
    tabId: args.tabId,
    error: blocker,
    elapsedMs: args.elapsedMs
  };
}

function makeResearchExecution(bundle: DeterministicResearchBundle): BrowserToolExecution {
  const publicBundle = compactBundleForExecution(bundle);
  const okSources = bundle.evidenceCards.filter((card) => card.status === "ok");
  const status: BrowserToolExecution["status"] =
    bundle.sufficiency.status === "sufficient"
      ? bundle.warnings.length ? "partial" : "success"
      : okSources.length ? "partial" : "failed";
  const browserStatus: BrowserExecutionStatus =
    status === "success" ? "completed" : status === "partial" ? "partial" : "failed";
  const callId = makeId("deterministic_research");
  const summary = `${bundle.candidates.length} link(s), ${okSources.length} extracted source(s), sufficiency ${bundle.sufficiency.status} (${bundle.sufficiency.coverageScore}), ${bundle.timingsMs.total}ms.`;
  const visibleAction: VisibleBrowserAction = {
    id: makeId("action"),
    kind: "source_lookup",
    eventType: "tool",
    label: "Deterministic research",
    status: browserStatus,
    visible: true,
    startedAt: bundle.startedAt,
    endedAt: bundle.completedAt,
    resultSummary: summary,
    warning: bundle.warnings[0],
    metadata: {
      query: bundle.searchQuery,
      googleSearchUrl: bundle.googleSearchUrl
    }
  };
  const toolResult: ToolExecutionResult<DeterministicResearchBundle> = {
    callId,
    toolName: "deterministic_research",
    status,
    output: publicBundle,
    error: status === "failed" ? bundle.warnings[0] ?? "Deterministic research produced no readable sources." : undefined,
    warnings: bundle.warnings,
    visibleActions: [visibleAction],
    startedAt: bundle.startedAt,
    endedAt: bundle.completedAt
  };
  const stepResult: UniversalStepResult<DeterministicResearchBundle> = {
    stepId: callId,
    capability: "deterministic_research",
    status: browserStatus === "completed" ? "completed" : browserStatus,
    startedAt: bundle.startedAt,
    completedAt: bundle.completedAt,
    input: {
	      prompt: bundle.originalPrompt,
	      query: bundle.searchQuery,
	      candidateBatchSize: CANDIDATE_BATCH_SIZE,
	      sufficiency: bundle.sufficiency.status
	    },
    output: publicBundle,
    warnings: bundle.warnings,
    errors: status === "failed" ? [toolResult.error ?? "Deterministic research failed."] : [],
    visibleActionPerformed: true,
    evidenceProduced: okSources.length > 0,
    summary,
    toolName: "deterministic_research",
    toolResult
  };
  const focused = [...bundle.sources].reverse().find((source) => source.extractionMethod === "visible_tab");
  const failures = status === "failed"
    ? [makeFailureEvidence("deterministic_research", toolResult.error ?? "Deterministic research failed.", bundle.startedAt)]
    : [];

  return {
    callId,
    toolName: "deterministic_research",
    status,
    output: publicBundle,
    error: toolResult.error,
    warnings: bundle.warnings,
    summary,
    activity: {
      id: makeId("log"),
      timestamp: bundle.completedAt,
      level: status === "failed" ? "error" : status === "partial" ? "warning" : "info",
      label: "Deterministic research",
      details: summary,
      toolName: "deterministic_research",
      actionLabel: "Preflight search/extract",
      status: browserStatus,
      eventType: "tool",
      resultSummary: summary,
      warning: bundle.warnings[0]
    },
    stepResult,
    toolResult,
    evidenceItems: makeEvidenceItems(bundle),
    failures,
    searchCandidates: bundle.candidates,
    openedSources: makeOpenedSources(bundle),
    extractedSections: bundle.evidenceCards.flatMap((card) => card.extractedFacts).slice(0, 80),
    extractedTextSample: bundle.evidenceCards
      .filter((card) => card.relevantPassages.length)
      .map((card) => `[${card.rank}] ${card.title}\n${card.relevantPassages.join("\n")}`)
      .join("\n\n")
      .slice(0, MAX_SOURCE_PROMPT_CHARS),
    prunedTabIds: [],
    groupedTabIds: [],
    focusedTab: focused
      ? {
          tabId: focused.tabId,
          title: focused.title,
          url: focused.url
        }
      : undefined,
    browserState: makeBrowserState(bundle),
    visibleActions: [visibleAction]
  };
}

function compactBundleForExecution(bundle: DeterministicResearchBundle): DeterministicResearchBundle {
  return {
    ...bundle,
    sources: bundle.sources.map((source) => ({
      ...source,
      headings: source.headings.slice(0, 8),
      text: ""
    })),
    audit: bundle.audit
  };
}

function makeEvidenceItems(bundle: DeterministicResearchBundle): EvidenceItem[] {
  const items: EvidenceItem[] = [
    {
      id: makeId("evidence"),
      createdAt: bundle.completedAt,
      type: "value",
      evidenceClass: "executed_tool",
      quality: bundle.candidates.length ? "partial" : "thin",
      summary: `Compiled query: ${bundle.searchQuery}`,
      warnings: [],
      label: "Deterministic search query",
      value: {
        query: bundle.searchQuery,
        googleSearchUrl: bundle.googleSearchUrl,
        candidates: bundle.candidates
      },
      provenance: {
        toolName: "deterministic_research",
        collectedAt: bundle.completedAt
      }
    }
  ];

  for (const card of bundle.evidenceCards.filter((candidate) => candidate.relevantPassages.length)) {
    items.push({
      id: makeId("evidence"),
      createdAt: bundle.completedAt,
      type: "page",
      evidenceClass: "executed_tool",
      quality: card.status === "ok" ? "strong" : "partial",
      summary: `evidence_card: ${card.title}`,
      warnings: card.warning ? [card.warning] : [],
      url: card.url,
      title: card.title,
      headings: card.extractedFacts,
      textSample: card.relevantPassages.join("\n\n"),
      provenance: {
        toolName: "deterministic_research",
        url: card.url,
        title: card.title,
        collectedAt: bundle.completedAt
      }
    });
  }

  return items;
}

function makeOpenedSources(bundle: DeterministicResearchBundle): OpenedSourceEvidence[] {
  return bundle.sources
    .filter((source) => source.extractionMethod === "visible_tab")
    .map((source) => ({
      tabId: source.tabId,
      title: source.title,
      url: source.url,
      wasStrongest: source.rank === 1
    }));
}

function makeBrowserState(bundle: DeterministicResearchBundle): EvidenceBrowserState | undefined {
  const focused = [...bundle.sources].reverse().find((source) => source.extractionMethod === "visible_tab");
  if (!focused) {
    return undefined;
  }

  return {
    activeTab: {
      tabId: focused.tabId,
      title: focused.title,
      url: focused.url
    },
    currentPage: {
      title: focused.title,
      url: focused.url
    },
    openedTabs: [
      {
        tabId: focused.tabId,
        title: focused.title,
        url: focused.url
      }
    ]
  };
}

function parseGoogleResultCandidates(html: string, maxResults: number): SearchCandidate[] {
  const anchors = Array.from(html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi));
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];

  for (const anchor of anchors) {
    const rawHref = decodeHtml(anchor[2]);
    if (!isGoogleResultRedirect(rawHref) && !isPotentialDirectResultLink(rawHref)) {
      continue;
    }

    const url = normalizeSearchResultUrl(rawHref);
    const fallbackTitle = url ? domainFromUrl(url) ?? url : "";
    const title = cleanText(stripTags(anchor[3])) || fallbackTitle;
    if (!url || isUtilityCandidate(url, title) || seen.has(normalizeForDedupe(url))) {
      continue;
    }

    seen.add(normalizeForDedupe(url));
    candidates.push({
      id: makeId("candidate"),
      title: clip(title, 180),
      url,
      domain: domainFromUrl(url)
    });

    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

async function extractGoogleResultCandidates(tabId: number, maxResults: number): Promise<VisibleSearchResult[]> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectGoogleSearchResultCandidates,
    args: [maxResults]
  });

  if (!Array.isArray(result?.result)) {
    return [];
  }

  return result.result
    .map((candidate): VisibleSearchResult => ({
      title: String(candidate.title ?? "").trim(),
      url: String(candidate.url ?? "").trim(),
      snippet: candidate.snippet ? String(candidate.snippet).trim() : undefined
    }))
    .filter((candidate) => candidate.title && candidate.url);
}

function collectGoogleSearchResultCandidates(maxResults: number): VisibleSearchResult[] {
  const candidates: VisibleSearchResult[] = [];
  const seen = new Set<string>();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const genericGoogleUiTitle =
    /^(all|images|videos|news|shopping|maps|books|flights|finance|search tools|tools|settings|privacy|terms)$/i;

  for (const anchor of anchors) {
    const heading = anchor.querySelector("h3") ?? anchor.closest("div")?.querySelector("h3");
    const title = (heading?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 4 || genericGoogleUiTitle.test(title)) {
      continue;
    }

    const href = anchor.href;
    if (!/^https?:\/\//i.test(href) || seen.has(href)) {
      continue;
    }

    const container = anchor.closest<HTMLElement>(
      "div.g, div.MjjYud, div[data-sokoban-container], div.ezO2md, div.tF2Cxc, div"
    );
    const rawText = (container?.innerText ?? "").replace(/\s+/g, " ").trim();
    const snippet = rawText
      .replace(title, " ")
      .replace(href, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);

    seen.add(href);
    candidates.push({
      title,
      url: href,
      snippet: snippet && snippet !== title ? snippet : undefined
    });

    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

function candidatesFromVisibleSearchResults(results: VisibleSearchResult[], maxResults: number): SearchCandidate[] {
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];

  for (const result of results) {
    const url = normalizeSearchResultUrl(result.url);
    if (!url || isUtilityCandidate(url, result.title) || seen.has(normalizeForDedupe(url))) {
      continue;
    }

    seen.add(normalizeForDedupe(url));
    candidates.push({
      id: makeId("candidate"),
      title: clip(result.title, 180),
      url,
      domain: domainFromUrl(url),
      snippet: result.snippet ? clip(result.snippet, 260) : undefined
    });

    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

function candidatesFromLinks(links: Array<{ text: string; url: string }>, maxResults: number): SearchCandidate[] {
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];

  for (const link of links) {
    const url = normalizeSearchResultUrl(link.url);
    if (!url || isUtilityCandidate(url, link.text) || seen.has(normalizeForDedupe(url))) {
      continue;
    }

    seen.add(normalizeForDedupe(url));
    candidates.push({
      id: makeId("candidate"),
      title: link.text || domainFromUrl(url) || url,
      url,
      domain: domainFromUrl(url)
    });

    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

function mergeCandidates(...groups: SearchCandidate[][]): SearchCandidate[] {
  const seen = new Set<string>();
  const merged: SearchCandidate[] = [];

  for (const candidate of groups.flat()) {
    const key = normalizeForDedupe(candidate.url);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(candidate);
  }

  return merged;
}

function normalizeSearchResultUrl(rawHref: string): string | undefined {
  const decoded = decodeHtml(rawHref);
  let resolved: URL;
  try {
    resolved = new URL(decoded, "https://www.google.com");
  } catch {
    return undefined;
  }

  if (resolved.hostname === "www.google.com" || resolved.hostname === "google.com") {
    if (resolved.pathname === "/url") {
      const target = resolved.searchParams.get("q") ?? resolved.searchParams.get("url");
      if (!target) {
        return undefined;
      }

      try {
        resolved = new URL(target);
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }

  if (isGoogleInfrastructureUrl(resolved)) {
    return undefined;
  }

  resolved.hash = "";
  return resolved.href;
}

function isGoogleResultRedirect(rawHref: string): boolean {
  try {
    const parsed = new URL(decodeHtml(rawHref), "https://www.google.com");
    return (parsed.hostname === "www.google.com" || parsed.hostname === "google.com") && parsed.pathname === "/url";
  } catch {
    return false;
  }
}

function isPotentialDirectResultLink(rawHref: string): boolean {
  try {
    const parsed = new URL(decodeHtml(rawHref), "https://www.google.com");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return !isGoogleInfrastructureUrl(parsed);
  } catch {
    return false;
  }
}

function detectGoogleSearchBlocker(html: string): string | undefined {
  if (/\/httpservice\/retry\/enablejs|emsg=SG_REL|enablejs/i.test(html)) {
    return "Google fetch returned an enable-JavaScript retry page instead of organic results.";
  }

  if (/unusual traffic|sorry\/index|captcha|detected unusual/i.test(html)) {
    return "Google fetch returned an anti-automation page instead of organic results.";
  }

  if (/consent\.google|before you continue|agree to the use of cookies/i.test(html)) {
    return "Google fetch returned a consent page instead of organic results.";
  }

  return undefined;
}

function isUtilityCandidate(url: string, title: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const normalizedTitle = title.toLowerCase();

  if (host === "support.google.com" && path.startsWith("/websearch")) {
    return true;
  }

  if (host === "support.google.com" && /google search help|manage your google account|feedback/.test(normalizedTitle)) {
    return true;
  }

  return /\b(cached|similar pages|feedback|privacy|terms|settings)\b/.test(normalizedTitle);
}

function utilityPenalty(candidate: SearchCandidate, intent: SearchIntent): number {
  const url = safeUrl(candidate.url);
  if (!url) {
    return 100;
  }

  const host = normalizedHostname(url);
  const title = candidate.title.toLowerCase();
  const hostIsNamed = intent.namedDomains.some((domain) => domainMatches(host, domain));
  let penalty = 0;

  if (isGoogleInfrastructureUrl(url)) {
    penalty += 100;
  }

  if (host.endsWith("google.com") && !hostIsNamed) {
    const serviceName = host.split(".")[0];
    const serviceWasRequested = intent.terms.includes(serviceName);
    penalty += serviceWasRequested ? 5 : 55;
  }

  if (host === "support.google.com" && !hostIsNamed) {
    penalty += 80;
  }

  if (/\b(help center|support|privacy policy|terms of service|account|settings|maps|labs)\b/.test(title) && !hostIsNamed) {
    penalty += 30;
  }

  return penalty;
}

function isGoogleInfrastructureUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "accounts.google.com" || host === "policies.google.com" || host.endsWith(".gstatic.com")) {
    return true;
  }

  return host === "www.google.com" || host === "google.com";
}

function snapshotFromFetchedText(url: string, raw: string, contentType: string, maxChars: number): PageSnapshot {
  if (/text\/plain/i.test(contentType)) {
    return {
      url,
      title: domainFromUrl(url) ?? url,
      headings: [],
      text: cleanText(raw).slice(0, maxChars),
      links: []
    };
  }

  const html = raw.slice(0, 1_000_000);
  const title = cleanText(stripTags(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? ""));
  const description = cleanText(
    matchFirst(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i) ??
      matchFirst(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i) ??
      ""
  ) || undefined;
  const headings = Array.from(html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((match) => cleanText(stripTags(match[1])))
    .filter(Boolean)
    .slice(0, 60);
  const body = matchFirst(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  const text = cleanText(
    stripTags(
      body
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<(br|p|div|section|article|main|li|h[1-6]|tr)\b[^>]*>/gi, "\n$&")
    )
  ).slice(0, maxChars);

  return {
    url,
    title: title || domainFromUrl(url) || url,
    description,
    headings,
    text,
    links: []
  };
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<{ response: Response; text: string; url: string }> {
  const fetchUrl = normalizeHttpsFetchUrl(url);
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(fetchUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        ...headers
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${fetchUrl}.`);
    }

    const text = await response.text();
    return { response, text, url: response.url || fetchUrl };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function findNewSearchTab(tabIdsBefore: Set<number>): Promise<chrome.tabs.Tab> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(250);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const newActiveTab = tabs.find((tab) => tab.active && tab.id !== undefined && !tabIdsBefore.has(tab.id));
    if (newActiveTab) {
      return newActiveTab;
    }

    const newTab = tabs.find((tab) => tab.id !== undefined && !tabIdsBefore.has(tab.id));
    if (newTab) {
      return newTab;
    }
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    throw new Error("No search results tab was opened.");
  }

  return activeTab;
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const current = await chrome.tabs.get(tabId).catch(() => undefined);
  if (current?.status === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = globalThis.setTimeout(cleanup, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(listener);
      globalThis.clearTimeout(timeoutId);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForExtractableSnapshot(
  tabId: number,
  options: { maxChars: number; includeLinks: boolean; timeoutMs: number }
): Promise<PageSnapshot> {
  const deadline = Date.now() + options.timeoutMs;
  let lastSnapshot: PageSnapshot | undefined;
  let lastUsefulLength = 0;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const snapshot = await snapshotTab(tabId, {
      maxChars: options.maxChars,
      includeLinks: options.includeLinks
    });
    lastSnapshot = snapshot;

    const usefulLength = cleanPageTextForEvidence(snapshot.text).length;
    const blocked = Boolean(detectBlockingReason(`${snapshot.title}\n${snapshot.text}`));
    const stable = Math.abs(usefulLength - lastUsefulLength) < 80;
    if (!blocked && usefulLength >= MIN_EXTRACTABLE_TEXT_CHARS && (stable || stableCount > 0)) {
      return snapshot;
    }

    stableCount = stable ? stableCount + 1 : 0;
    lastUsefulLength = usefulLength;
    await delay(EXTRACTABLE_CONTENT_POLL_MS);
  }

  if (lastSnapshot) {
    return lastSnapshot;
  }

  return snapshotTab(tabId, {
    maxChars: options.maxChars,
    includeLinks: options.includeLinks
  });
}

function makeGoogleSearchUrl(query: string, start = 0): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(GOOGLE_RESULT_POOL_SIZE));
  url.searchParams.set("hl", "en");
  url.searchParams.set("pws", "0");
  url.searchParams.set("filter", "0");
  url.searchParams.set("udm", "14");
  if (start > 0) {
    url.searchParams.set("start", String(start));
  }
  return url.href;
}

function isReadableContentType(contentType: string): boolean {
  return !contentType || /text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType);
}

function needsFreshness(text: string): boolean {
  return /\b(latest|current|recent|today|now|this week|news|price|pricing|availability|release|changelog|up to date|updated)\b/i.test(text);
}

function requiredTabId(tab: chrome.tabs.Tab | undefined): number {
  if (tab?.id === undefined) {
    throw new Error("Tab id is unavailable.");
  }

  return tab.id;
}

function normalizeHttpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported.");
  }

  return url.href;
}

function normalizeHttpsFetchUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are supported for background fetches.");
  }

  return url.href;
}

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function domainMatches(candidateDomain: string, targetDomain: string): boolean {
  const candidate = candidateDomain.toLowerCase().replace(/^www\./, "");
  const target = targetDomain.toLowerCase().replace(/^www\./, "");
  return candidate === target || candidate.endsWith(`.${target}`);
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function matchFirst(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function cleanText(value: string): string {
  return decodeHtml(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectBlockingReason(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(BLOCKING_PAGE_PATTERN);
  return match ? `Blocked or non-extractable page state: ${match[0]}.` : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, entity: string) => HTML_ENTITIES[entity.toLowerCase()] ?? match);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function makeFailureEvidence(toolName: string, error: string, createdAt: string): ToolFailureEvidence {
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

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 28))}\n[truncated ${value.length - maxChars + 28} chars]`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "browse",
  "can",
  "cite",
  "could",
  "find",
  "for",
  "from",
  "google",
  "how",
  "i",
  "in",
  "internet",
  "is",
  "it",
  "latest",
  "look",
  "me",
  "my",
  "now",
  "of",
  "on",
  "online",
  "or",
  "please",
  "recent",
  "source",
  "sources",
  "that",
  "the",
  "this",
  "to",
  "today",
  "up",
  "verify",
  "what",
  "when",
  "where",
  "why",
  "with",
  "you"
]);

const COMMON_TLDS = new Set([
  "ai",
  "app",
  "co",
  "com",
  "dev",
  "edu",
  "gov",
  "info",
  "io",
  "me",
  "net",
  "news",
  "org",
  "site",
  "social",
  "tv"
]);

const QUERY_FILLER_WORDS = new Set([
  "about",
  "approach",
  "approaches",
  "best",
  "build",
  "building",
  "create",
  "creating",
  "did",
  "do",
  "does",
  "implement",
  "implementing",
  "implementation",
  "optimal",
  "recommended",
  "use",
  "using",
  "way",
  "ways",
  "would"
]);

const VIDEO_INTENT_TERMS = new Set([
  "clip",
  "clips",
  "demo",
  "lecture",
  "presentation",
  "talk",
  "transcript",
  "transcripts",
  "video",
  "videos",
  "watch",
  "webinar",
  "youtube"
]);

const BOILERPLATE_LINE_PATTERN =
  /\b(cookie|cookies|privacy|terms|subscribe|newsletter|advertisement|advertising|sponsored|sign in|log in|login|create account|menu|navigation|skip to|share this|all rights reserved|copyright|enable javascript|accept all|reject all|related articles|recommended|read more|follow us|download app|open app)\b/i;

const BLOCKING_PAGE_PATTERN =
  /\b(please wait for verification|verify you are human|checking your browser|captcha|access denied|forbidden|blocked|sign in to confirm|log in to continue|enable javascript|unusual traffic|automated queries|are you a robot|security check|just a moment)\b/i;

const HIGH_VALUE_INTERNAL_LINK_PATTERN =
  /\b(docs?|documentation|api|developers?|guides?|learn|reference|pricing|plans?|changelog|release|releases|updates?|news|blog|announcements?|research|papers?|whitepaper|architecture|engineering)\b/i;

const UTILITY_INTERNAL_LINK_PATTERN =
  /\b(sign in|signin|log in|login|logout|sign up|signup|account|dashboard|contact|privacy|terms|cookie|cookies|careers?|jobs?|press kit|brand|newsletter|subscribe|cart|checkout|download app|ios app|android app|status)\b/i;

const SITE_ALIASES: Array<{
  domain: string;
  names: string[];
  patterns: RegExp[];
}> = [
  {
    domain: "reddit.com",
    names: ["reddit"],
    patterns: [/\breddit\b/i]
  },
  {
    domain: "github.com",
    names: ["github"],
    patterns: [/\bgithub\b/i]
  },
  {
    domain: "youtube.com",
    names: ["youtube"],
    patterns: [/\byoutube\b/i, /\byou tube\b/i]
  },
  {
    domain: "wikipedia.org",
    names: ["wikipedia"],
    patterns: [/\bwikipedia\b/i, /\bwiki\b/i]
  },
  {
    domain: "stackoverflow.com",
    names: ["stackoverflow", "stack overflow"],
    patterns: [/\bstack\s*overflow\b/i, /\bstackoverflow\b/i]
  },
  {
    domain: "news.ycombinator.com",
    names: ["hacker news", "hn"],
    patterns: [/\bhacker\s*news\b/i, /\bhn\b/i]
  },
  {
    domain: "x.com",
    names: ["x", "twitter"],
    patterns: [/\btwitter\b/i, /\bx\.com\b/i]
  },
  {
    domain: "linkedin.com",
    names: ["linkedin"],
    patterns: [/\blinkedin\b/i]
  },
  {
    domain: "instagram.com",
    names: ["instagram"],
    patterns: [/\binstagram\b/i]
  },
  {
    domain: "tiktok.com",
    names: ["tiktok"],
    patterns: [/\btiktok\b/i, /\btik\s*tok\b/i]
  },
  {
    domain: "docs.google.com",
    names: ["google docs"],
    patterns: [/\bgoogle\s+docs\b/i]
  },
  {
    domain: "maps.google.com",
    names: ["google maps"],
    patterns: [/\bgoogle\s+maps\b/i]
  },
  {
    domain: "labs.google",
    names: ["google labs"],
    patterns: [/\bgoogle\s+labs\b/i]
  }
];

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\""
};
