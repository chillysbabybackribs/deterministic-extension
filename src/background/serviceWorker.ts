import { runHaikuToolChat } from "./haikuToolRunner";
import type {
  RunPortClientMessage,
  RunPortServerMessage,
  RunProgressEvent,
  RunRequest,
  RunResponse
} from "../shared/protocol";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRunRequest(message)) {
    return false;
  }

  runHaikuToolChat({
    userMessage: message.message,
    settings: message.settings,
    history: message.history ?? []
  })
    .then((response) => sendResponse(response))
    .catch((error) => {
      const text = error instanceof Error ? error.message : "Unknown background failure.";
      const response: RunResponse = {
        ok: false,
        answer: text,
        activity: [],
        error: text
      };
      sendResponse(response);
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ohmygod.run") {
    return;
  }

  let started = false;
  port.onMessage.addListener((message: unknown) => {
    if (started || !isRunRequest(message)) {
      return;
    }

    started = true;
    const request = message as RunPortClientMessage;
    const post = (serverMessage: RunPortServerMessage) => {
      try {
        port.postMessage(serverMessage);
      } catch {
        // The sidepanel can close while a deterministic browser run is still unwinding.
      }
    };

    runHaikuToolChat({
      userMessage: request.message,
      settings: request.settings,
      history: request.history ?? [],
      onProgress: (event: RunProgressEvent) => post({ type: "ohmygod.progress", event })
    })
      .then((response) => post({ type: "ohmygod.done", response }))
      .catch((error) => {
        const text = error instanceof Error ? error.message : "Unknown background failure.";
        const response: RunResponse = {
          ok: false,
          answer: text,
          activity: [],
          error: text
        };
        post({ type: "ohmygod.done", response });
      });
  });
});

function isRunRequest(value: unknown): value is RunRequest {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "ohmygod.run" &&
    typeof (value as { message?: unknown }).message === "string";
}
