/**
 * Primary network-capture source: chrome.debugger (Chrome DevTools Protocol).
 *
 * This is the more complete source — it sees response bodies, full request and
 * response headers, redirects, and WebSocket frames the page never exposed to
 * script. The cost is Chrome's mandatory yellow "extension is debugging this
 * browser" banner on the attached tab, which is exactly the visible-capture
 * signal we want. Attach happens only on explicit user action (the
 * browser_capture_network start tool), never as a side effect.
 *
 * Requires the "debugger" permission declared as a required manifest
 * permission. Chrome does not allow "debugger" in optional_permissions.
 */

import {
  addFrame,
  addRequest,
  clampBody,
  createBuffer,
  detectGraphql,
  findRequest,
  framePreview,
  getBuffer,
  originOf,
  pathOf,
  type CaptureBuffer,
  type CapturedHeader
} from "./captureBuffer";

const CDP_VERSION = "1.3";

type Attachment = {
  tabId: number;
  /** Maps CDP requestId -> our buffer entry id (they are the same string). */
  detach: () => Promise<void>;
};

const attachments = new Map<number, Attachment>();

export function isCdpCapturing(tabId: number): boolean {
  return attachments.has(tabId);
}

export async function hasDebuggerPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ["debugger"] });
}

export async function startCdpCapture(tabId: number): Promise<CaptureBuffer> {
  if (attachments.has(tabId)) {
    const existing = getBuffer(tabId);
    if (existing) {
      return existing;
    }
  }

  const target: chrome.debugger.Debuggee = { tabId };
  await attachDebugger(target);

  const buffer = createBuffer(tabId, "cdp");

  const onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown
  ): void => {
    if (source.tabId !== tabId) {
      return;
    }
    handleCdpEvent(tabId, method, params as Record<string, unknown> | undefined);
  };

  const onDetach = (source: chrome.debugger.Debuggee): void => {
    if (source.tabId === tabId) {
      void teardown(tabId);
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);

  attachments.set(tabId, {
    tabId,
    detach: async () => {
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.onDetach.removeListener(onDetach);
      await detachDebugger(target).catch(() => undefined);
    }
  });

  await sendCommand(target, "Network.enable", {
    maxResourceBufferSize: 10_000_000,
    maxTotalBufferSize: 50_000_000
  });

  return buffer;
}

export async function stopCdpCapture(tabId: number): Promise<void> {
  const attachment = attachments.get(tabId);
  if (!attachment) {
    return;
  }
  attachments.delete(tabId);
  await attachment.detach();
}

/** Detach without removing the buffer (used when the tab closes/navigates away). */
async function teardown(tabId: number): Promise<void> {
  const attachment = attachments.get(tabId);
  if (!attachment) {
    return;
  }
  attachments.delete(tabId);
  await attachment.detach().catch(() => undefined);
}

function handleCdpEvent(tabId: number, method: string, params?: Record<string, unknown>): void {
  const buffer = getBuffer(tabId);
  if (!buffer || !params) {
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const requestId = String(params.requestId ?? "");
    const request = asRecord(params.request);
    const url = String(request.url ?? "");
    const method_ = String(request.method ?? "GET");
    const headers = headersFromRecord(request.headers);
    const postData = typeof request.postData === "string" ? request.postData : undefined;
    addRequest(buffer, {
      id: requestId,
      source: "cdp",
      startedAtMs: Date.now(),
      method: method_,
      url,
      origin: originOf(url),
      path: pathOf(url),
      resourceType: typeof params.type === "string" ? params.type : undefined,
      requestHeaders: headers,
      responseHeaders: [],
      requestBody: clampBody(postData),
      responseBodyPending: true,
      graphql: detectGraphql(url, postData),
      sensitiveKinds: []
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = String(params.requestId ?? "");
    const entry = findRequest(buffer, requestId);
    if (!entry) {
      return;
    }
    const response = asRecord(params.response);
    entry.status = typeof response.status === "number" ? response.status : entry.status;
    entry.statusText = typeof response.statusText === "string" ? response.statusText : entry.statusText;
    entry.responseHeaders = headersFromRecord(response.headers);
    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = String(params.requestId ?? "");
    const entry = findRequest(buffer, requestId);
    if (!entry) {
      return;
    }
    void fetchResponseBody(tabId, requestId, entry.startedAtMs);
    return;
  }

  if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
    const requestId = String(params.requestId ?? "");
    const frame = asRecord(params.response);
    const payload = typeof frame.payloadData === "string" ? frame.payloadData : "";
    addFrame(buffer, {
      id: `${requestId}:${Date.now()}`,
      source: "cdp",
      atMs: Date.now(),
      direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
      opcode: typeof frame.opcode === "number" ? frame.opcode : undefined,
      payloadLength: payload.length,
      payloadPreview: framePreview(payload),
      payload: clampBody(payload)
    });
  }
}

async function fetchResponseBody(tabId: number, requestId: string, startedAtMs: number): Promise<void> {
  const buffer = getBuffer(tabId);
  const entry = buffer ? findRequest(buffer, requestId) : undefined;
  if (!buffer || !entry) {
    return;
  }
  entry.durationMs = Date.now() - startedAtMs;
  try {
    const result = (await sendCommand({ tabId }, "Network.getResponseBody", { requestId })) as {
      body?: string;
      base64Encoded?: boolean;
    };
    const body = result.base64Encoded ? decodeBase64(result.body) : result.body;
    entry.responseBody = clampBody(body);
    entry.responseBodyPending = false;
  } catch {
    entry.responseBodyPending = false;
  }
}

// --- chrome.debugger promisified wrappers --------------------------------------

function attachDebugger(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(debuggerErrorMessage(error.message)));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function sendCommand(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function debuggerErrorMessage(message?: string): string {
  if (message && /another debugger|already attached|devtools/i.test(message)) {
    return `${message} Close DevTools on this tab (only one debugger can attach at a time), then retry.`;
  }
  return message ?? "Could not attach the debugger to this tab.";
}

function headersFromRecord(value: unknown): CapturedHeader[] {
  const record = asRecord(value);
  return Object.entries(record).map(([name, raw]) => ({
    name,
    value: typeof raw === "string" ? raw : String(raw)
  }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function decodeBase64(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  try {
    return atob(value);
  } catch {
    return value;
  }
}
