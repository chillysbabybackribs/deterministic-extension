import { runPipeline } from "./pipeline/pipelineRunner";
import type {
  RunControlAction,
  RunPortClientMessage,
  RunPortServerMessage,
  RunProgressEvent,
  RunProgressStatus,
  RunRequest,
  RunResponse,
  WorkspaceToolResponse
} from "../shared/protocol";
import { createRunControl } from "./runControl";
import { ensureShimContentScripts } from "../tools/networkCapture/pageShimCapture";
import {
  clearActionableOverlayForPageChange,
  forgetActionableOverlayTab,
  isActionableOverlayTracked,
  scheduleActionableOverlayRepaint,
  showActionableOverlay,
  transferActionableOverlayTab,
  hideActionableOverlay
} from "../tools/elementOverlay";
import { getCachedSiteRecon, initReconCache } from "./reconCache";
import { listWebCorpusDescriptors } from "../webcorpus/webCorpusStore";
import { buildSiteRecon, harvestPageLinks, renderSiteRecon, type SiteRecon } from "../tools/siteRecon";
import {
  setWorkspaceToolDelegate,
  type BrowserToolCall,
  type BrowserToolExecution
} from "../tools/browserToolExecutor";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import { makeId } from "../shared/id";

const RUN_PORT_KEEPALIVE_INTERVAL_MS = 20_000;

type PendingWorkspaceTool = {
  resolve: (execution: BrowserToolExecution) => void;
  reject: (error: Error) => void;
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ensureShimContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureShimContentScripts();
});

// Also register on cold service-worker spin-up; the calls are idempotent
// (registration-exists check) so repeated invocations are safe.
void ensureShimContentScripts();

// --- Per-page site recon (auto-run once per page load, cached per tab) --------
// When a tab finishes loading a web page, harvest its links + read robots/sitemap
// once and cache the inventory so a later prompt finds it already built.
const reconCache = initReconCache(async (tabId, origin): Promise<SiteRecon | undefined> => {
  try {
    const [harvested] = await chrome.scripting.executeScript({ target: { tabId }, func: harvestPageLinks });
    const harvest = (harvested?.result as { origin: string; hrefs: string[]; formActions: string[] }) ??
      { origin, hrefs: [], formActions: [] };
    return await buildSiteRecon({ harvest });
  } catch {
    return undefined; // unsupported page / injection blocked — skip silently.
  }
}, () => Date.now());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    void clearActionableOverlayForPageChange(tabId).then((wasTracked) => {
      if (wasTracked && changeInfo.url && changeInfo.status !== "loading") {
        scheduleActionableOverlayRepaint(tabId);
      }
    });
  }

  if (changeInfo.status === "complete") {
    void reconCache.maybeRun(tabId, tab.url);
    // The repaint re-captures via showActionableOverlay, which itself folds the
    // page into the web corpus — so persistence rides on the capture, not here.
    if (isActionableOverlayTracked(tabId)) {
      scheduleActionableOverlayRepaint(tabId);
    }
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  reconCache.clearTab(tabId);
  forgetActionableOverlayTab(tabId);
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  reconCache.clearTab(removed);
  if (transferActionableOverlayTab(removed, added)) {
    scheduleActionableOverlayRepaint(added);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTrustedRuntimeSender(sender)) {
    return false;
  }

  if (isActionableOverlayRequest(message)) {
    const tabId = message.tabId;
    const op = message.op === "hide"
      ? hideActionableOverlay(tabId).then(() => undefined)
      : showActionableOverlay(tabId);
    op
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  // Dev readout: return the current/target tab's cached site-recon inventory, so
  // it can be inspected from the service-worker console. Read-only, no recompute.
  if (isSiteReconRequest(message)) {
    const respond = (tabId: number | undefined) => {
      const recon = tabId !== undefined ? getCachedSiteRecon(tabId) : undefined;
      sendResponse(
        recon
          ? { ok: true, tabId, origin: recon.origin, pathCount: recon.paths.length, robots: recon.robots, warnings: recon.warnings, render: renderSiteRecon(recon, 80) }
          : { ok: true, tabId, recon: null, note: "No cached recon for this tab yet (load/reload a web page first)." }
      );
    };
    if (message.tabId !== undefined) {
      respond(message.tabId);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => respond(t?.id)).catch(() => respond(undefined));
    }
    return true;
  }




  // Readout: the accumulated web corpus, as compact site descriptors, for the
  // Settings panel. Read-only.
  if (isWebCorpusListRequest(message)) {
    listWebCorpusDescriptors()
      .then((sites) => sendResponse({ ok: true, sites }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (!isRunRequest(message)) {
    return false;
  }

  // Universal request path: every run goes through runPipeline.
  runPipeline({
    userMessage: message.message,
    settings: message.settings,
    history: message.history,
    activeCaptureContext: message.activeCaptureContext,
    activeWorkingFile: message.activeWorkingFile
  })
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse(makeBackgroundFailureResponse(error));
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!isTrustedRuntimeSender(port.sender)) {
    port.disconnect();
    return;
  }

  if (port.name !== "ohmygod.run") {
    return;
  }

  let started = false;
  let runFinished = false;
  const control = createRunControl();
  const pendingWorkspaceTools = new Map<string, PendingWorkspaceTool>();
  const post = (serverMessage: RunPortServerMessage) => {
    try {
      port.postMessage(serverMessage);
    } catch {
      // The sidepanel can close while a deterministic browser run is still unwinding.
    }
  };
  const keepaliveInterval = globalThis.setInterval(() => {
    if (!runFinished) {
      post({
        type: "ohmygod.keepalive",
        timestamp: new Date().toISOString()
      });
    }
  }, RUN_PORT_KEEPALIVE_INTERVAL_MS);
  const workspaceDelegate = (call: BrowserToolCall) => requestWorkspaceToolExecution(call, post, pendingWorkspaceTools);

  port.onMessage.addListener((message: unknown) => {
    if (isWorkspaceToolResponse(message)) {
      settleWorkspaceToolResponse(message, pendingWorkspaceTools);
      return;
    }

    if (isRunControlRequest(message)) {
      if (runFinished) {
        postControlProgress(post, message.action, false);
        return;
      }

      const accepted = message.action === "pause"
        ? control.pause()
        : message.action === "resume"
          ? control.resume()
          : control.stop();
      postControlProgress(post, message.action, accepted);
      return;
    }

    if (started || !isRunRequest(message)) {
      return;
    }

    started = true;
    const request = message;
    setWorkspaceToolDelegate(workspaceDelegate);

    // Universal request path: every run goes through runPipeline (plan → execute
    // → overlay/corpus/grep per page → gate → synthesize).
    const runChat = runPipeline({
      userMessage: request.message,
      settings: request.settings,
      history: request.history,
      activeCaptureContext: request.activeCaptureContext,
      activeWorkingFile: request.activeWorkingFile,
      onProgress: (event: RunProgressEvent) => post({ type: "ohmygod.progress", event }),
      onAnswerDelta: (delta: string) => post({ type: "ohmygod.answer_delta", delta }),
      control
    });

    runChat
      .then((response) => post({ type: "ohmygod.done", response }))
      .catch((error) => {
        post({ type: "ohmygod.done", response: makeBackgroundFailureResponse(error) });
      })
      .finally(() => {
        runFinished = true;
        setWorkspaceToolDelegate(undefined);
        rejectPendingWorkspaceTools(pendingWorkspaceTools, "Run finished before the workspace tool returned.");
        globalThis.clearInterval(keepaliveInterval);
      });
  });

  port.onDisconnect.addListener(() => {
    globalThis.clearInterval(keepaliveInterval);
    setWorkspaceToolDelegate(undefined);
    rejectPendingWorkspaceTools(pendingWorkspaceTools, "Run channel disconnected before the workspace tool returned.");
    if (!runFinished) {
      control.stop();
    }
  });
});

function isRunRequest(value: unknown): value is RunRequest {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.run" &&
    typeof (value as { message?: unknown }).message === "string";
}

function makeBackgroundFailureResponse(error: unknown): RunResponse {
  const text = error instanceof Error ? error.message : "Unknown background failure.";
  return {
    ok: false,
    answer: text,
    activity: [makeBackgroundFailureLog(text)],
    error: text
  };
}

function makeBackgroundFailureLog(message: string): ExecutionLogEntry {
  return {
    id: makeId("log"),
    timestamp: new Date().toISOString(),
    level: "error",
    label: "Background runner",
    details: message,
    toolName: "background",
    actionLabel: "Run failed",
    status: "failed",
    eventType: "failure",
    warning: message
  };
}

function isTrustedRuntimeSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  return !sender?.id || sender.id === chrome.runtime.id;
}

type ActionableOverlayRequest = {
  type: "ohmygod.actionableOverlay";
  op: "show" | "hide";
  tabId?: number;
};

function isActionableOverlayRequest(value: unknown): value is ActionableOverlayRequest {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.actionableOverlay" &&
    ((value as { op?: unknown }).op === "show" || (value as { op?: unknown }).op === "hide");
}

type SiteReconRequest = { type: "ohmygod.getSiteRecon"; tabId?: number };

function isSiteReconRequest(value: unknown): value is SiteReconRequest {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.getSiteRecon";
}

function isWebCorpusListRequest(value: unknown): value is { type: "ohmygod.listWebCorpus" } {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.listWebCorpus";
}

function isRunControlRequest(value: unknown): value is Extract<RunPortClientMessage, { type: "ohmygod.control" }> {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.control" &&
    ((value as { action?: unknown }).action === "pause" ||
      (value as { action?: unknown }).action === "resume" ||
      (value as { action?: unknown }).action === "stop");
}

function isWorkspaceToolResponse(value: unknown): value is WorkspaceToolResponse {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.workspace_tool_response" &&
    typeof (value as { requestId?: unknown }).requestId === "string";
}

function requestWorkspaceToolExecution(
  call: BrowserToolCall,
  post: (message: RunPortServerMessage) => void,
  pendingWorkspaceTools: Map<string, PendingWorkspaceTool>
): Promise<BrowserToolExecution> {
  const requestId = `workspace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    pendingWorkspaceTools.set(requestId, { resolve, reject });
    post({
      type: "ohmygod.workspace_tool_request",
      requestId,
      call
    });
  });
}

function settleWorkspaceToolResponse(
  response: WorkspaceToolResponse,
  pendingWorkspaceTools: Map<string, PendingWorkspaceTool>
): void {
  const pending = pendingWorkspaceTools.get(response.requestId);
  if (!pending) {
    return;
  }

  pendingWorkspaceTools.delete(response.requestId);
  if (response.execution) {
    pending.resolve(response.execution);
    return;
  }

  pending.reject(new Error(response.error ?? "Workspace tool failed in the side panel."));
}

function rejectPendingWorkspaceTools(
  pendingWorkspaceTools: Map<string, PendingWorkspaceTool>,
  message: string
): void {
  for (const [requestId, pending] of pendingWorkspaceTools.entries()) {
    pendingWorkspaceTools.delete(requestId);
    pending.reject(new Error(message));
  }
}

function postControlProgress(
  post: (message: RunPortServerMessage) => void,
  action: RunControlAction,
  accepted: boolean
): void {
  const statusByAction: Record<RunControlAction, RunProgressStatus> = {
    pause: "paused",
    resume: "running",
    stop: "stopped"
  };
  const labelByAction: Record<RunControlAction, string> = {
    pause: "Paused",
    resume: "Resumed",
    stop: "Stopped"
  };
  const detailByAction: Record<RunControlAction, string> = {
    pause: accepted ? "Run paused. Browser work will resume from the next checkpoint." : "Pause was ignored because the run is not active.",
    resume: accepted ? "Run resumed." : "Resume was ignored because the run is not paused.",
    stop: accepted ? "Run stop requested. In-flight browser work will unwind." : "Stop was ignored because the run already finished."
  };

  post({
    type: "ohmygod.progress",
    event: {
      id: `control_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      level: action === "stop" ? "warning" : "info",
      label: labelByAction[action],
      detail: detailByAction[action],
      status: statusByAction[action]
    }
  });
}
