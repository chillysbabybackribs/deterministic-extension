import { useEffect, useMemo, useState } from "react";
import {
  createChatMessage,
  type ChatContextMessage,
  type ChatMessage
} from "../conversation/conversationTypes";
import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import {
  DEFAULT_APP_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings
} from "../settings/settingsStore";
import type {
  RunPortServerMessage,
  RunProgressEvent,
  RunRequest,
  RunResponse
} from "../shared/protocol";
import { ChatWindow } from "../ui/components/ChatWindow";
import { SettingsPanel } from "../ui/components/SettingsPanel";
import { AppShell } from "./AppShell";

const WELCOME_MESSAGE = "Ask me normally, or ask me to use the browser. Haiku 4.5 receives the browser tool list directly.";

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    createChatMessage(
      "assistant",
      WELCOME_MESSAGE
    )
  ]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ExecutionLogEntry[]>([]);
  const [latestEvidence, setLatestEvidence] = useState<EvidencePacket | undefined>();
  const [progressEvents, setProgressEvents] = useState<RunProgressEvent[]>([]);
  const [progressOpen, setProgressOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const runtimeAvailable = useMemo(() => typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage), []);

  useEffect(() => {
    loadSettings().then(setSettings).catch(() => setSettings(DEFAULT_APP_SETTINGS));
  }, []);

  async function handleSettingsChange(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function handleSend(content: string) {
    const trimmed = content.trim();
    if (!trimmed || busy) {
      return;
    }

    const userMessage = createChatMessage("user", trimmed);
    const history = chatContextFromMessages(messages);
    setMessages((current) => [...current, userMessage]);
    setBusy(true);
    setActivity([]);
    setLatestEvidence(undefined);
    setProgressEvents([]);
    setProgressOpen(true);

    try {
      if (!settings.provider.apiKey?.trim()) {
        throw new Error("Add an Anthropic API key in settings before using Haiku 4.5.");
      }

      if (!runtimeAvailable) {
        throw new Error("Chrome extension runtime is not available. Build and load the unpacked extension.");
      }

      const response = await sendRunMessage(
        {
          type: "ohmygod.run",
          message: trimmed,
          settings,
          history
        },
        (event) => {
          setProgressEvents((current) => [...current, event].slice(-160));
          setProgressOpen(true);
        }
      );

      setActivity(response.activity);
      setLatestEvidence(response.evidence);
      setProgressOpen(false);
      setMessages((current) => [
        ...current,
        createChatMessage("assistant", response.answer, {
          status: response.ok ? "complete" : "error",
          evidencePacket: response.evidence,
          warnings: response.error ? [response.error] : undefined
        })
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown run failure.";
      setProgressOpen(false);
      setMessages((current) => [
        ...current,
        createChatMessage("assistant", message, {
          status: "error",
          warnings: [message]
        })
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      settingsOpen={settingsOpen}
      onToggleSettings={() => setSettingsOpen((open) => !open)}
      chat={
        <ChatWindow
          messages={messages}
          busy={busy}
	          activity={activity}
	          evidence={latestEvidence}
	          progressEvents={progressEvents}
	          progressOpen={progressOpen}
	          showEvidence={settings.dev.showEvidencePreview}
	          onSend={handleSend}
	        />
      }
      settings={
        settingsOpen ? (
          <SettingsPanel settings={settings} onChange={handleSettingsChange} />
        ) : null
      }
    />
  );
}

function chatContextFromMessages(messages: ChatMessage[]): ChatContextMessage[] {
  return messages
    .filter((message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.status !== "error" &&
      message.content !== WELCOME_MESSAGE
    )
    .map((message): ChatContextMessage => ({
      role: message.role === "user" ? "user" : "assistant",
      content: message.content
    }))
    .slice(-12);
}

async function sendRunMessage(
  request: RunRequest,
  onProgress?: (event: RunProgressEvent) => void
): Promise<RunResponse> {
  if (onProgress && typeof chrome !== "undefined") {
    return sendRunPortMessage(request, onProgress);
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RunResponse | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response) {
        reject(new Error("No response returned from background runner."));
        return;
      }

      resolve(response);
    });
  });
}

async function sendRunPortMessage(
  request: RunRequest,
  onProgress?: (event: RunProgressEvent) => void
): Promise<RunResponse> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "ohmygod.run" });
    let settled = false;

    port.onMessage.addListener((message: RunPortServerMessage) => {
      if (message.type === "ohmygod.progress") {
        onProgress?.(message.event);
        return;
      }

      if (message.type === "ohmygod.done") {
        settled = true;
        port.disconnect();
        resolve(message.response);
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        const runtimeError = chrome.runtime.lastError;
        reject(new Error(runtimeError?.message ?? "Run channel disconnected before a response was returned."));
      }
    });

    port.postMessage(request);
  });
}
