/**
 * One-shot, idempotent patch: add the deterministic_network_capture and
 * deterministic_page_inspection dispatch handlers to haikuToolRunner.ts.
 *
 * Earlier Edit attempts silently failed (they referenced non-existent helpers
 * buildAnswerResponse/streamFinalAnswerIfNeeded). This script operates on the
 * real file bytes (immune to the session's terminal-rendering glitch), asserts
 * its anchors, refuses to double-apply, and self-verifies.
 */
import fs from "node:fs";

const FILE = "src/background/haikuToolRunner.ts";
let s = fs.readFileSync(FILE, "utf8");
const count = (n) => s.split(n).length - 1;
const fail = (m) => { console.error("ABORTED: " + m); process.exit(1); };

// --- Idempotency guard -------------------------------------------------------
if (count("async function answerWithDeterministicPageInspection") > 0) {
  fail("answerWithDeterministicPageInspection already present; nothing to do.");
}
if (count("async function answerWithDeterministicNetworkCapture") > 0) {
  fail("answerWithDeterministicNetworkCapture already present; nothing to do.");
}

// --- Anchor 1: dispatch insertion point --------------------------------------
const dispatchAnchor = '    if (route.capabilities[0] === "deterministic_research") {';
if (count(dispatchAnchor) !== 1) {
  fail(`dispatch anchor found ${count(dispatchAnchor)} times (expected 1).`);
}

const dispatchBranches = `    if (route.capabilities.includes("deterministic_network_capture")) {
      return answerWithDeterministicNetworkCapture({
        userMessage: args.userMessage,
        settings: args.settings,
        history: args.history,
        activeCaptureContext: args.activeCaptureContext,
        onProgress: args.onProgress,
        onAnswerDelta: args.onAnswerDelta,
        control: args.control,
        activity,
        evidence
      });
    }

    if (route.capabilities.includes("deterministic_page_inspection")) {
      return answerWithDeterministicPageInspection({
        userMessage: args.userMessage,
        settings: args.settings,
        history: args.history,
        activeCaptureContext: args.activeCaptureContext,
        onProgress: args.onProgress,
        onAnswerDelta: args.onAnswerDelta,
        control: args.control,
        activity,
        evidence
      });
    }

`;
s = s.replace(dispatchAnchor, dispatchBranches + dispatchAnchor);

// --- Anchor 2: function insertion point --------------------------------------
const fnAnchor = "async function answerWithDeterministicResearch";
if (count(fnAnchor) !== 1) {
  fail(`function anchor found ${count(fnAnchor)} times (expected 1).`);
}

// Mirrors the proven answerWithDeterministicWorkspace return shape: run the
// deterministic preflight, format a COMPACT bundle, send only that to the model,
// and return via guardFilesystemWriteResponse + finalizeEvidence.
const newFns = `async function answerWithDeterministicNetworkCapture(args: {
  userMessage: string;
  settings: AppSettings;
  history: ChatContextMessage[];
  activeCaptureContext?: string;
  onProgress?: (event: RunProgressEvent) => void;
  onAnswerDelta?: (delta: string) => void;
  control?: RunControl;
  activity: ExecutionLogEntry[];
  evidence: EvidenceAccumulator;
}): Promise<RunResponse> {
  const capture = await runDeterministicNetworkCapturePreflight({
    userMessage: args.userMessage,
    onProgress: args.onProgress,
    control: args.control
  });
  args.activity.push(...capture.activity);

  // Synthesis boundary: only the compact, capped summary reaches the model.
  const sourceBundle = formatDeterministicNetworkCaptureForLlm(capture.bundle);
  const synthesisModel = args.settings.model.researchSynthesisModel === CLAUDE_SONNET_4_6_MODEL ||
    args.settings.model.model === CLAUDE_SONNET_4_6_MODEL
    ? CLAUDE_SONNET_4_6_MODEL
    : CLAUDE_HAIKU_4_5_MODEL;

  const synthesisResponse = await callFinalAnthropicMessage({
    settings: args.settings,
    model: synthesisModel,
    system: NETWORK_CAPTURE_SYNTHESIS_SYSTEM_PROMPT,
    messages: buildResearchSynthesisMessages(
      args.history,
      args.userMessage,
      sourceBundle,
      args.activeCaptureContext
    ),
    signal: args.control?.signal,
    onAnswerDelta: args.onAnswerDelta
  });
  const answer = extractText(synthesisResponse.content) || "I could not capture network traffic for this page.";

  return guardFilesystemWriteResponse({
    userMessage: args.userMessage,
    response: {
      ok: capture.bundle.status !== "failed",
      answer,
      activity: args.activity,
      evidence: finalizeEvidence(args.evidence),
      error: capture.bundle.status === "failed" ? capture.bundle.errors[0] : undefined
    }
  });
}

async function answerWithDeterministicPageInspection(args: {
  userMessage: string;
  settings: AppSettings;
  history: ChatContextMessage[];
  activeCaptureContext?: string;
  onProgress?: (event: RunProgressEvent) => void;
  onAnswerDelta?: (delta: string) => void;
  control?: RunControl;
  activity: ExecutionLogEntry[];
  evidence: EvidenceAccumulator;
}): Promise<RunResponse> {
  const inspection = await runDeterministicPageInspectionPreflight({
    onProgress: args.onProgress,
    control: args.control
  });
  args.activity.push(...inspection.activity);

  // Synthesis boundary: only the grounded, capped bundle reaches the model.
  const sourceBundle = formatDeterministicPageInspectionForLlm(inspection.bundle);
  const synthesisModel = args.settings.model.researchSynthesisModel === CLAUDE_SONNET_4_6_MODEL ||
    args.settings.model.model === CLAUDE_SONNET_4_6_MODEL
    ? CLAUDE_SONNET_4_6_MODEL
    : CLAUDE_HAIKU_4_5_MODEL;

  const draftResponse = await callFinalAnthropicMessage({
    settings: args.settings,
    model: synthesisModel,
    system: PAGE_INSPECTION_SYNTHESIS_SYSTEM_PROMPT,
    messages: buildResearchSynthesisMessages(
      args.history,
      args.userMessage,
      sourceBundle,
      args.activeCaptureContext
    ),
    signal: args.control?.signal,
    onAnswerDelta: args.onAnswerDelta
  });
  let answer = extractText(draftResponse.content);

  // Verifier pass: strip gap-filled / attribute-inferred claims against the bundle.
  if (answer && inspection.bundle.status !== "failed") {
    const verifierResponse = await callFinalAnthropicMessage({
      settings: args.settings,
      model: synthesisModel,
      system: PAGE_INSPECTION_VERIFIER_SYSTEM_PROMPT,
      messages: buildResearchVerificationMessages(
        args.userMessage,
        sourceBundle,
        answer,
        args.activeCaptureContext
      ),
      signal: args.control?.signal
    });
    const verified = extractText(verifierResponse.content);
    if (verified) {
      answer = verified;
    }
  }

  return guardFilesystemWriteResponse({
    userMessage: args.userMessage,
    response: {
      ok: inspection.bundle.status !== "failed",
      answer: answer || "I could not inspect this page.",
      activity: args.activity,
      evidence: finalizeEvidence(args.evidence),
      error: inspection.bundle.status === "failed" ? inspection.bundle.errors[0] : undefined
    }
  });
}

`;
s = s.replace(fnAnchor, newFns + fnAnchor);

fs.writeFileSync(FILE, s);

// --- Self-verify -------------------------------------------------------------
const after = fs.readFileSync(FILE, "utf8");
const c = (n) => after.split(n).length - 1;
const report = {
  net_fn: c("async function answerWithDeterministicNetworkCapture"),
  page_fn: c("async function answerWithDeterministicPageInspection"),
  net_dispatch: c('route.capabilities.includes("deterministic_network_capture")'),
  page_dispatch: c('route.capabilities.includes("deterministic_page_inspection")'),
  research_dispatch_anchor: c(dispatchAnchor)
};
console.log(JSON.stringify(report));
const ok = report.net_fn === 1 && report.page_fn === 1 &&
  report.net_dispatch === 1 && report.page_dispatch === 1 &&
  report.research_dispatch_anchor === 1;
process.exit(ok ? 0 : 2);
