import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type ChatConversation,
  type ChatConversationSummary,
  createChatMessage,
  type ChatContextMessage,
  type ChatMessage
} from "../conversation/conversationTypes";
import {
  clearChatHistory,
  createConversationId,
  loadChatHistory,
  saveChatHistory
} from "../conversation/conversationStore";
import type { EvidencePacket } from "../evidence/evidenceTypes";
import type { ExecutionLogEntry } from "../execution/executionTypes";
import {
  DEFAULT_APP_SETTINGS,
  loadSettings,
  saveSettings,
  type AppSettings
} from "../settings/settingsStore";
import type { ProviderSettings } from "../settings/providerSettings";
import {
  collectWorkspaceTextFiles,
  disconnectWorkspace,
  getWorkspaceStatus,
  requestWorkspaceAccess,
  selectWorkspaceFromPicker,
  workspaceNeedsWriteGrant,
  type WorkspaceStatus
} from "../filesystem/workspaceStore";
import {
  cancelUiCaptureInActiveTab,
  captureUiFromActiveTab,
  type CapturedUiReference,
  formatCapturedUiDisplaySummary,
  formatCapturedUiDisplayText,
  formatCapturedUiReferenceForRequest
} from "../tools/pageCapture";
import { planComponentTemplate } from "../tools/componentTemplatePlanner";
import type { ActiveWorkingFileDescriptor } from "../filecorpus/corpusTypes";
import { ingestFile } from "../filecorpus/ingest";
import { ingestFolder, TrickleController } from "../filecorpus/ingestFolder";
import type { EmbedTexts } from "../filecorpus/embedUnits";
import { embedTexts, hasGeminiApiKey } from "../embeddings/geminiEmbeddingClient";
import { buildReuseIndex } from "../filecorpus/reuseEmbeddings";
import {
  activeDescriptorFromCorpus,
  clearActiveCorpus,
  getActiveCorpus,
  getActiveCorpusStatus,
  putCorpus,
  setActiveCorpus
} from "../filecorpus/corpusStore";
import type {
  RunControlAction,
  RunPortServerMessage,
  RunProgressEvent,
  RunRequest,
  RunResponse,
  WorkspaceToolResponse
} from "../shared/protocol";
import { executeBrowserToolLocally } from "../tools/browserToolExecutor";
import { hasLikelyWorkspaceWriteIntent } from "../shared/workspaceIntent";
import { ChatWindow } from "../ui/components/ChatWindow";
import { SettingsPanel } from "../ui/components/SettingsPanel";
import { useCompanion } from "../companion/useCompanion";
import { CompanionSetup } from "../ui/components/CompanionSetup";
import { AppShell } from "./AppShell";

const LEGACY_WELCOME_MESSAGE = "Ask a question, research the web, work with the current page, or use your selected workspace.\n\nI can help with questions, current pages, web research, browser tasks, and files in your selected workspace.";
const TYPEWRITER_INTERVAL_MS = 18;
const TYPEWRITER_FAST_FINISH_INTERVAL_MS = 6;

type RunUiState = "idle" | "running" | "paused" | "stopping";

type RunClientControls = {
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

export type AppProps = {
  authControls?: ReactNode;
};

export function App({ authControls }: AppProps = {}) {
  const companion = useCompanion();
  const [messages, setMessages] = useState<ChatMessage[]>(() => createWelcomeMessages());
  const [busy, setBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [activeCapture, setActiveCapture] = useState<CapturedUiReference | undefined>();
  const [activeWorkingFile, setActiveWorkingFile] = useState<ActiveWorkingFileDescriptor | undefined>();
  const [workingFileBusy, setWorkingFileBusy] = useState(false);
  const [workingFileError, setWorkingFileError] = useState<string>();
  const [activity, setActivity] = useState<ExecutionLogEntry[]>([]);
  const [latestEvidence, setLatestEvidence] = useState<EvidencePacket | undefined>();
  const [progressEvents, setProgressEvents] = useState<RunProgressEvent[]>([]);
  const [progressOpen, setProgressOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [runState, setRunState] = useState<RunUiState>("idle");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceStatus>();
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [conversationLoaded, setConversationLoaded] = useState(false);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const runtimeAvailable = useMemo(() => typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage), []);
  const conversationSummaries = useMemo(
    () => conversations.map(toConversationSummary),
    [conversations]
  );
  const generatedPreviewPlan = useMemo(
    () => activeCapture ? planComponentTemplate(activeCapture) : undefined,
    [activeCapture]
  );
  const visibleProgressEvents = useMemo(
    () => progressEvents
      .filter((event) => settings.dev.showDebugLogs || event.level !== "debug")
      .filter(isVisibleProgressEvent),
    [progressEvents, settings.dev.showDebugLogs]
  );
  const progressOpenedByUserRef = useRef(false);
  const runControlsRef = useRef<RunClientControls>();
  // Owns the active folder-ingest background trickle so a new attach/refresh/clear
  // aborts the previous run (abort-on-switch).
  const trickleControllerRef = useRef<TrickleController>(new TrickleController());

  useEffect(() => {
    loadSettings().then(setSettings).catch(() => setSettings(DEFAULT_APP_SETTINGS));
    getWorkspaceStatus().then(setWorkspace).catch((error) => {
      setWorkspaceError(error instanceof Error ? error.message : "Could not read workspace status.");
    });
    // Rehydrate the sticky working file so it survives a panel reopen.
    getActiveCorpusStatus()
      .then((status) => {
        if (status.active) {
          const { active: _active, ...descriptor } = status;
          setActiveWorkingFile(descriptor);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadChatHistory()
      .then((storedHistory) => {
        if (cancelled) {
          return;
        }

        const activeConversation =
          storedHistory.conversations.find((conversation) => conversation.id === storedHistory.activeConversationId) ??
          storedHistory.conversations[0];

        setConversations(storedHistory.conversations);
        setActiveConversationId(activeConversation?.id);
        setMessages(activeConversation ? activeConversation.messages : createWelcomeMessages());
        resetRunState(false, activeConversation?.activity ?? [], activeConversation?.latestEvidence);
      })
      .catch(() => {
        if (!cancelled) {
          setMessages(createWelcomeMessages());
          resetRunState(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setConversationLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!conversationLoaded) {
      return;
    }

    const persistHistory = conversations.length
      ? saveChatHistory({ activeConversationId, conversations })
      : clearChatHistory();
    persistHistory.catch(() => undefined);
  }, [activeConversationId, conversationLoaded, conversations]);

  async function handleSettingsChange(nextSettings: AppSettings) {
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function handleSaveApiKeys(keys: Pick<ProviderSettings, "apiKey" | "geminiApiKey" | "openaiApiKey">) {
    await handleSettingsChange({
      ...settings,
      provider: {
        ...settings.provider,
        ...keys
      }
    });
  }

  async function handleConnectWorkspace() {
    setWorkspaceBusy(true);
    setWorkspaceError(undefined);
    try {
      const currentWorkspace = workspace?.connected ? workspace : await getWorkspaceStatus().catch(() => undefined);
      setWorkspace(workspaceNeedsWriteGrant(currentWorkspace)
        ? await requestWorkspaceAccess("readwrite")
        : await selectWorkspaceFromPicker());
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not connect workspace.");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function ensureWorkspaceWriteAccessForPrompt(prompt: string): Promise<void> {
    if (!hasLikelyWorkspaceWriteIntent(prompt)) {
      return;
    }

    const currentWorkspace = workspace ?? await getWorkspaceStatus().catch(() => undefined);
    if (!workspaceNeedsWriteGrant(currentWorkspace)) {
      return;
    }

    setWorkspaceBusy(true);
    setWorkspaceError(undefined);
    try {
      setWorkspace(await requestWorkspaceAccess("readwrite"));
    } catch (error) {
      const status = await getWorkspaceStatus().catch(() => workspace);
      setWorkspace(status);
      const message = error instanceof Error ? error.message : "Chrome did not grant write access to the selected folder.";
      setWorkspaceError(message);
      throw new Error(`${message} Click the workspace button and grant write access, then run the request again.`);
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function handleDisconnectWorkspace() {
    setWorkspaceBusy(true);
    setWorkspaceError(undefined);
    try {
      await disconnectWorkspace();
      setWorkspace(await getWorkspaceStatus());
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not disconnect workspace.");
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function handleSend(content: string) {
    const trimmed = content.trim();
    if (!trimmed || busy || !conversationLoaded) {
      return;
    }

    const conversationId = activeConversationId ?? createConversationId();
    const userMessage = createChatMessage("user", trimmed);
    const previousMessages = chatHistoryMessages(messages);
    const history = chatContextFromMessages(previousMessages);
    const activeCaptureContext = activeCapture ? formatCapturedUiReferenceForRequest(activeCapture) : undefined;
    let runMessages = [...previousMessages, userMessage];
    let streamedAssistant: ChatMessage | undefined;
    let streamedDisplayed = "";
    let streamedQueued = "";
    let typewriterTimer: number | undefined;
    let typewriterFlushResolvers: Array<() => void> = [];
    let typewriterFastFinish = false;
    const reducedMotion = prefersReducedMotion();

    const clearTypewriterTimer = () => {
      if (typewriterTimer !== undefined) {
        window.clearTimeout(typewriterTimer);
        typewriterTimer = undefined;
      }
    };

    const resolveTypewriterFlush = () => {
      if (streamedQueued || typewriterTimer !== undefined) {
        return;
      }

      const resolvers = typewriterFlushResolvers;
      typewriterFlushResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    };

    const revealQueuedImmediately = () => {
      clearTypewriterTimer();
      if (!streamedQueued) {
        resolveTypewriterFlush();
        return;
      }

      ensureStreamedAssistant();
      streamedDisplayed += streamedQueued;
      streamedQueued = "";
      updateStreamedAssistant(streamedDisplayed, { status: "sending" });
      resolveTypewriterFlush();
    };

    const updateStreamedAssistant = (content: string, extra: Partial<ChatMessage> = {}) => {
      if (!streamedAssistant) {
        return;
      }

      streamedAssistant = {
        ...streamedAssistant,
        content,
        ...extra
      };
      runMessages = runMessages.map((message) =>
        message.id === streamedAssistant?.id ? streamedAssistant : message
      );
      setMessages(runMessages);
    };

    const ensureStreamedAssistant = () => {
      if (streamedAssistant) {
        return;
      }

      streamedAssistant = createChatMessage("assistant", "", {
        status: "sending"
      });
      runMessages = [...runMessages, streamedAssistant];
      setMessages(runMessages);
    };

    const runTypewriterStep = () => {
      typewriterTimer = undefined;
      if (!streamedQueued) {
        resolveTypewriterFlush();
        return;
      }

      ensureStreamedAssistant();
      const take = typewriterTakeLength(streamedQueued, typewriterFastFinish);
      streamedDisplayed += streamedQueued.slice(0, take);
      streamedQueued = streamedQueued.slice(take);
      updateStreamedAssistant(streamedDisplayed, { status: "sending" });

      if (streamedQueued) {
        typewriterTimer = window.setTimeout(
          runTypewriterStep,
          typewriterFastFinish ? TYPEWRITER_FAST_FINISH_INTERVAL_MS : TYPEWRITER_INTERVAL_MS
        );
        return;
      }

      resolveTypewriterFlush();
    };

    const scheduleTypewriter = () => {
      if (reducedMotion) {
        revealQueuedImmediately();
        return;
      }

      if (typewriterTimer !== undefined) {
        return;
      }

      typewriterTimer = window.setTimeout(
        runTypewriterStep,
        typewriterFastFinish ? TYPEWRITER_FAST_FINISH_INTERVAL_MS : TYPEWRITER_INTERVAL_MS
      );
    };

    const handleAnswerDelta = (delta: string) => {
      if (!delta) {
        return;
      }

      if (!progressOpenedByUserRef.current) {
        setProgressOpen(false);
      }
      ensureStreamedAssistant();
      streamedQueued += delta;
      if (reducedMotion) {
        revealQueuedImmediately();
      } else {
        scheduleTypewriter();
      }
    };

    const waitForTypewriterDrain = () => {
      if (!streamedQueued && typewriterTimer === undefined) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        typewriterFlushResolvers.push(resolve);
      });
    };

    const reconcileStreamedAnswer = async (answer: string) => {
      if (!streamedAssistant) {
        return;
      }

      if (reducedMotion) {
        streamedDisplayed = answer;
        streamedQueued = "";
        updateStreamedAssistant(answer, { status: "sending" });
        resolveTypewriterFlush();
        return;
      }

      const bufferedAnswer = streamedDisplayed + streamedQueued;
      if (answer && answer !== bufferedAnswer) {
        if (answer.startsWith(streamedDisplayed)) {
          streamedQueued = answer.slice(streamedDisplayed.length);
        } else {
          streamedDisplayed = "";
          streamedQueued = answer;
          updateStreamedAssistant("", { status: "sending" });
        }
      }

      typewriterFastFinish = true;
      if (streamedQueued) {
        clearTypewriterTimer();
        scheduleTypewriter();
      }
      await waitForTypewriterDrain();
    };

    setActiveConversationId(conversationId);
    setMessages(runMessages);
    setConversations((current) => upsertConversation(current, conversationId, runMessages, {
      activity: [],
      latestEvidence: undefined
    }));
    setBusy(true);
    setRunState("running");
    setChatHistoryOpen(false);
    resetRunState(false);
    progressOpenedByUserRef.current = false;

    try {
      if (!settings.provider.apiKey?.trim()) {
        throw new Error("Add an Anthropic API key in Settings before using the assistant.");
      }

      if (!runtimeAvailable) {
        throw new Error("Chrome extension runtime is not available. Build and load the unpacked extension.");
      }

      await ensureWorkspaceWriteAccessForPrompt(trimmed);

      if (activeCaptureContext) {
        setActiveCapture(undefined);
      }
      const response = await sendRunMessage(
        {
          type: "ohmygod.run",
          message: trimmed,
          settings,
          history,
          activeCaptureContext,
          // Sticky: the working file stays attached across turns (unlike the
          // one-shot capture context above) until the user clears it.
          activeWorkingFile
        },
        (event) => {
          setProgressEvents((current) => [...current, event].slice(-160));
          updateRunStateFromProgress(event, setRunState);
          const visibleProgressEvent = isVisibleProgressEvent(event);

          if (visibleProgressEvent && isResponseStartProgressEvent(event)) {
            if (!progressOpenedByUserRef.current) {
              setProgressOpen(false);
            }
          }
        },
        (controls) => {
          runControlsRef.current = controls;
        },
        handleAnswerDelta
      );

      setActivity(response.activity);
      setLatestEvidence(response.evidence);
      setProgressOpen((open) => shouldKeepProgressOpenAfterResponse(progressOpenedByUserRef.current, open));
      await reconcileStreamedAnswer(response.answer);
      if (streamedAssistant) {
        updateStreamedAssistant(response.answer, {
          status: response.ok ? "complete" : "error",
          evidencePacket: response.evidence,
          warnings: response.error ? [response.error] : undefined,
          capabilityGap: response.capabilityGap
        });
      } else {
        runMessages = [
          ...runMessages,
          createChatMessage("assistant", response.answer, {
            status: response.ok ? "complete" : "error",
            evidencePacket: response.evidence,
            warnings: response.error ? [response.error] : undefined,
            capabilityGap: response.capabilityGap
          })
        ];
        setMessages(runMessages);
      }
      setConversations((current) => upsertConversation(current, conversationId, runMessages, {
        activity: response.activity,
        latestEvidence: response.evidence
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown run failure.";
      clearTypewriterTimer();
      setProgressOpen(false);
      if (streamedAssistant) {
        const partialAnswer = `${streamedDisplayed}${streamedQueued}`.trim();
        updateStreamedAssistant(partialAnswer || message, {
          status: "error",
          warnings: [message]
        });
      } else {
        runMessages = [
          ...runMessages,
          createChatMessage("assistant", message, {
            status: "error",
            warnings: [message]
          })
        ];
        setMessages(runMessages);
      }
      setConversations((current) => upsertConversation(current, conversationId, runMessages, {
        activity: [],
        latestEvidence: undefined
      }));
    } finally {
      clearTypewriterTimer();
      runControlsRef.current = undefined;
      setRunState("idle");
      setBusy(false);
    }
  }

  async function handleCaptureUi() {
    if (busy || !conversationLoaded) {
      return;
    }

    if (captureBusy) {
      await cancelUiCaptureInActiveTab();
      return;
    }

    setCaptureBusy(true);
    try {
      if (!runtimeAvailable) {
        throw new Error("Chrome extension runtime is not available. Build and load the unpacked extension.");
      }

      const capture = await captureUiFromActiveTab();
      if (!capture) {
        return;
      }

      const conversationId = activeConversationId ?? createConversationId();
      const captureSummary = formatCapturedUiDisplaySummary(capture);
      const captureMessage = createChatMessage("user", formatCapturedUiDisplayText(captureSummary), {
        captureSummary
      });
      const nextMessages = [...chatHistoryMessages(messages), captureMessage];
      setActiveCapture(capture);
      setActiveConversationId(conversationId);
      setMessages(nextMessages);
      setChatHistoryOpen(false);
      setSettingsOpen(false);
      setConversations((current) => upsertConversation(current, conversationId, nextMessages, {
        activity,
        latestEvidence
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown UI capture failure.";
      const conversationId = activeConversationId ?? createConversationId();
      const errorMessage = createChatMessage("assistant", message, {
        status: "error",
        warnings: [message]
      });
      const nextMessages = [...chatHistoryMessages(messages), errorMessage];
      setActiveConversationId(conversationId);
      setMessages(nextMessages);
      setConversations((current) => upsertConversation(current, conversationId, nextMessages, {
        activity,
        latestEvidence
      }));
    } finally {
      setCaptureBusy(false);
    }
  }

  /**
   * Build the ingest-time embedder from current settings, or undefined when no
   * Gemini key is set (ingest then stays lexical — graceful degrade). The key is
   * captured at connect time, so a folder trickle keeps embedding with the key it
   * started with even if settings change mid-build.
   */
  function makeEmbedder(): EmbedTexts | undefined {
    if (!hasGeminiApiKey(settings)) {
      return undefined;
    }
    const captured = settings;
    return (texts: string[]) => embedTexts({ settings: captured, texts });
  }

  async function handleAttachWorkingFile() {
    if (busy || workingFileBusy) {
      return;
    }
    const picker = (globalThis as typeof globalThis & {
      showOpenFilePicker?: (options?: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
    }).showOpenFilePicker;
    if (!picker) {
      setWorkingFileError("This browser does not support attaching a file.");
      return;
    }

    setWorkingFileError(undefined);
    let file: File;
    try {
      const [handle] = await picker({
        types: [{
          description: "Documents and spreadsheets",
          accept: {
            "text/plain": [".txt", ".md", ".markdown"],
            "text/csv": [".csv", ".tsv"],
            "application/pdf": [".pdf"],
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"]
          }
        }]
      });
      if (!handle) {
        return;
      }
      file = await handle.getFile();
    } catch (error) {
      // AbortError = the user dismissed the picker (not an error). Anything else
      // is a real failure worth surfacing instead of silently doing nothing.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setWorkingFileError(error instanceof Error ? error.message : "Could not open the file picker.");
      }
      return;
    }

    trickleControllerRef.current.abort(); // a new file source supersedes any folder trickle
    setWorkingFileBusy(true);
    try {
      // Reuse vectors for unchanged content from whatever was last indexed.
      const reuse = buildReuseIndex(await getActiveCorpus());
      const corpus = await ingestFile(file, undefined, makeEmbedder(), reuse);
      await putCorpus(corpus);
      await setActiveCorpus(corpus.fileId);
      setActiveWorkingFile(activeDescriptorFromCorpus(corpus));
      if (corpus.warnings.length) {
        setWorkingFileError(corpus.warnings.join(" "));
      }
    } catch (error) {
      setWorkingFileError(error instanceof Error ? error.message : "Could not read that file.");
    } finally {
      setWorkingFileBusy(false);
    }
  }

  async function ingestActiveFolder() {
    // The folder is already connected (selectWorkspaceFromPicker ran). Walk it,
    // ingest a fast first slice so chat works immediately, then trickle the rest.
    const signal = trickleControllerRef.current.start();
    setWorkingFileBusy(true);
    setWorkingFileError(undefined);
    try {
      const collected = await collectWorkspaceTextFiles({ maxFiles: 2000, maxBytesPerFile: 1_000_000 });
      // Reuse vectors for unchanged content from the prior corpus (read before
      // this ingest overwrites the active pointer) — reconnects skip re-embedding.
      const reuse = buildReuseIndex(await getActiveCorpus());
      const { initial, done } = await ingestFolder({
        files: collected.files,
        rootName: collected.rootName,
        collectionWarnings: collected.warnings,
        signal,
        embed: makeEmbedder(),
        reuse,
        onUpdate: async (corpus) => {
          if (signal.aborted) {
            return;
          }
          await putCorpus(corpus);
          setActiveWorkingFile(activeDescriptorFromCorpus(corpus));
        }
      });
      await putCorpus(initial);
      await setActiveCorpus(initial.fileId);
      setActiveWorkingFile(activeDescriptorFromCorpus(initial));
      if (initial.warnings.length) {
        setWorkingFileError(initial.warnings.join(" "));
      }
      // The first slice is usable now; let the trickle finish in the background.
      void done.then((final) => {
        if (!signal.aborted) {
          setActiveWorkingFile(activeDescriptorFromCorpus(final));
        }
      });
    } catch (error) {
      setWorkingFileError(error instanceof Error ? error.message : "Could not read that folder.");
    } finally {
      setWorkingFileBusy(false);
    }
  }

  async function handleAttachFolder() {
    if (busy || workingFileBusy) {
      return;
    }
    let status: WorkspaceStatus;
    try {
      // selectWorkspaceFromPicker() must be the first call so the directory
      // picker runs inside the user gesture.
      status = await selectWorkspaceFromPicker();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setWorkingFileError(error instanceof Error ? error.message : "Could not open the folder picker.");
      }
      return;
    }
    setWorkspace(status);
    setWorkingFileError(undefined);
    if (!status.connected) {
      return;
    }
    await ingestActiveFolder();
  }

  async function handleRefreshSource() {
    if (busy || workingFileBusy || !activeWorkingFile) {
      return;
    }
    if (activeWorkingFile.sourceType === "folder") {
      await ingestActiveFolder();
    } else {
      // Single files: re-pick is the way to refresh (we don't retain the handle).
      await handleAttachWorkingFile();
    }
  }

  async function handleClearSource() {
    trickleControllerRef.current.abort();
    setWorkingFileError(undefined);
    setActiveWorkingFile(undefined);
    await clearActiveCorpus();
    // Fully detach whatever is connected — corpus AND the folder/file workspace.
    try {
      await disconnectWorkspace();
      setWorkspace(await getWorkspaceStatus());
    } catch {
      // Best-effort; the corpus is already cleared.
    }
  }

  function handlePauseRun() {
    if (runState !== "running") {
      return;
    }

    runControlsRef.current?.pause();
    setRunState("paused");
  }

  function handleResumeRun() {
    if (runState !== "paused") {
      return;
    }

    runControlsRef.current?.resume();
    setRunState("running");
  }

  function handleStopRun() {
    if (runState === "idle" || runState === "stopping") {
      return;
    }

    runControlsRef.current?.stop();
    setRunState("stopping");
  }

  function handleNewChat() {
    if (busy || !conversationLoaded) {
      return;
    }

    setActiveConversationId(undefined);
    setMessages(createWelcomeMessages());
    setActiveCapture(undefined);
    setChatHistoryOpen(false);
    resetRunState(false);
  }

  function handleSelectConversation(conversationId: string) {
    if (busy || !conversationLoaded) {
      return;
    }

    if (conversationId === activeConversationId) {
      setChatHistoryOpen(false);
      return;
    }

    const conversation = conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) {
      return;
    }

    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setActiveCapture(undefined);
    setChatHistoryOpen(false);
    resetRunState(false, conversation.activity, conversation.latestEvidence);
  }

  function handleDeleteConversation(conversationId: string) {
    if (busy || !conversationLoaded) {
      return;
    }

    const nextConversations = conversations.filter((conversation) => conversation.id !== conversationId);
    setConversations(nextConversations);

    if (activeConversationId === conversationId) {
      const nextActiveConversation = nextConversations[0];
      setActiveConversationId(nextActiveConversation?.id);
      setMessages(nextActiveConversation ? nextActiveConversation.messages : createWelcomeMessages());
      setActiveCapture(undefined);
      resetRunState(false, nextActiveConversation?.activity ?? [], nextActiveConversation?.latestEvidence);
    }
  }

  function resetRunState(
    openProgress: boolean,
    nextActivity: ExecutionLogEntry[] = [],
    nextEvidence?: EvidencePacket
  ) {
    setActivity(nextActivity);
    setLatestEvidence(nextEvidence);
    setProgressEvents([]);
    setProgressOpen(openProgress);
    progressOpenedByUserRef.current = openProgress;
  }

  return (
    <>
    {companion.setupOpen ? (
      <CompanionSetup
        connected={companion.connected}
        onClose={companion.closeSetup}
        onRefresh={companion.refresh}
      />
    ) : null}
    <AppShell
      authControls={authControls}
      chatBusy={busy || !conversationLoaded}
      chatHistoryOpen={chatHistoryOpen}
      settingsOpen={settingsOpen}
      source={activeWorkingFile}
      sourceBusy={workingFileBusy}
      sourceIngestedAt={activeWorkingFile?.ingestedAt}
      sourceError={workingFileError}
      onAttachFile={() => void handleAttachWorkingFile()}
      onAttachFolder={() => void handleAttachFolder()}
      onRefreshSource={() => void handleRefreshSource()}
      onClearSource={() => void handleClearSource()}
      onToggleChatHistory={() => {
        setSettingsOpen(false);
        setChatHistoryOpen((open) => !open);
      }}
      onToggleSettings={() => {
        setChatHistoryOpen(false);
        setSettingsOpen((open) => !open);
      }}
      onCloseSettings={() => setSettingsOpen(false)}
      chat={
        <ChatWindow
          messages={messages}
          settings={settings}
          conversations={conversationSummaries}
          activeConversationId={activeConversationId}
          chatHistoryOpen={chatHistoryOpen}
          busy={busy || !conversationLoaded}
          runState={runState}
          activity={settings.dev.showDebugLogs ? activity : activity.filter((entry) => entry.level !== "debug")}
          evidence={latestEvidence}
          progressEvents={visibleProgressEvents}
          thinkingEvents={progressEvents}
          progressOpen={progressOpen}
          generatedPreviewPlan={generatedPreviewPlan}
          showEvidence={settings.dev.showEvidencePreview}
          activityOpen={activityOpen}
          evidenceOpen={evidenceOpen}
          onCloseProgress={() => {
            progressOpenedByUserRef.current = false;
            setProgressOpen(false);
          }}
          onCloseChatHistory={() => setChatHistoryOpen(false)}
          onCloseActivity={() => setActivityOpen(false)}
          onCloseEvidence={() => setEvidenceOpen(false)}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onPauseRun={handlePauseRun}
          onOpenProgress={() => {
            progressOpenedByUserRef.current = true;
            setActivityOpen(false);
            setEvidenceOpen(false);
            setChatHistoryOpen(false);
            setProgressOpen(true);
          }}
          onResumeRun={handleResumeRun}
          onSaveApiKeys={handleSaveApiKeys}
          onSend={handleSend}
          onStopRun={handleStopRun}
          companion={{
            connected: companion.connected,
            dismissedGapMessageIds: companion.dismissedGapMessageIds,
            onInstall: companion.requestInstall,
            onDismissGap: companion.dismissGap,
            onAsk: (question) => void handleSend(question)
          }}
        />
      }
      settings={
        settingsOpen ? (
          <SettingsPanel
            settings={settings}
            activityCount={activity.length}
            activityOpen={activityOpen}
            evidenceCount={latestEvidence?.items.length ?? 0}
            evidenceOpen={evidenceOpen}
            showEvidence={settings.dev.showEvidencePreview}
            onChange={handleSettingsChange}
            onToggleActivity={() => {
              setActivityOpen((open) => !open);
              setEvidenceOpen(false);
              setChatHistoryOpen(false);
              setProgressOpen(false);
            }}
            onToggleEvidence={() => {
              setEvidenceOpen((open) => !open);
              setActivityOpen(false);
              setChatHistoryOpen(false);
              setProgressOpen(false);
            }}
          />
        ) : null
      }
    />
    </>
  );
}

function createWelcomeMessages(): ChatMessage[] {
  return [];
}

function chatHistoryMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== "assistant" || message.content !== LEGACY_WELCOME_MESSAGE);
}

function upsertConversation(
  conversations: ChatConversation[],
  conversationId: string,
  messages: ChatMessage[],
  metadata: Pick<ChatConversation, "activity" | "latestEvidence">
): ChatConversation[] {
  const historyMessages = chatHistoryMessages(messages);
  if (!historyMessages.length) {
    return conversations.filter((conversation) => conversation.id !== conversationId);
  }

  const existingConversation = conversations.find((conversation) => conversation.id === conversationId);
  const updatedConversation = createConversation(conversationId, historyMessages, metadata, existingConversation);
  return [
    updatedConversation,
    ...conversations.filter((conversation) => conversation.id !== conversationId)
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function createConversation(
  conversationId: string,
  messages: ChatMessage[],
  metadata: Pick<ChatConversation, "activity" | "latestEvidence">,
  existingConversation?: ChatConversation
): ChatConversation {
  return {
    id: conversationId,
    title: createConversationTitle(messages),
    createdAt: existingConversation?.createdAt ?? messages[0]?.createdAt ?? new Date().toISOString(),
    updatedAt: messages.at(-1)?.createdAt ?? new Date().toISOString(),
    messages,
    activity: metadata.activity,
    latestEvidence: metadata.latestEvidence
  };
}

function createConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? messages[0]?.content ?? "New chat";
  const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
  return clipText(normalized || "New chat", 56);
}

function toConversationSummary(conversation: ChatConversation): ChatConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length
  };
}

function clipText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function typewriterTakeLength(queue: string, fastFinish = false): number {
  if (!queue) {
    return 0;
  }

  const target = typewriterBaseTakeLength(queue.length, fastFinish);
  if (target >= queue.length) {
    return queue.length;
  }

  return typewriterBoundaryTakeLength(queue, target, fastFinish ? 48 : 18);
}

function typewriterBaseTakeLength(queueLength: number, fastFinish: boolean): number {
  if (fastFinish) {
    if (queueLength > 1200) {
      return 240;
    }

    if (queueLength > 400) {
      return 120;
    }

    if (queueLength > 80) {
      return 60;
    }

    return 24;
  }

  if (queueLength > 1200) {
    return 48;
  }

  if (queueLength > 400) {
    return 24;
  }

  if (queueLength > 80) {
    return 12;
  }

  return 6;
}

function typewriterBoundaryTakeLength(queue: string, target: number, searchRadius: number): number {
  const upperBound = Math.min(queue.length - 1, target + searchRadius);
  for (let index = target; index <= upperBound; index += 1) {
    if (isTypewriterBoundary(queue, index)) {
      return index;
    }
  }

  const lowerBound = Math.max(1, target - searchRadius);
  for (let index = target; index >= lowerBound; index -= 1) {
    if (isTypewriterBoundary(queue, index)) {
      return index;
    }
  }

  return target;
}

function isTypewriterBoundary(queue: string, index: number): boolean {
  const previous = queue[index - 1];
  const next = queue[index];
  if (!previous) {
    return false;
  }

  if (/\s/.test(previous)) {
    return true;
  }

  return /[),.;:!?]/.test(previous) && (!next || /\s/.test(next));
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isResponseStartProgressEvent(event: RunProgressEvent): boolean {
  return event.label.toLowerCase() === "synthesis" && event.status === "running";
}

export function isVisibleProgressEvent(event: RunProgressEvent): boolean {
  return VISIBLE_PROGRESS_LABELS.has(event.label.toLowerCase());
}

export function isResearchProgressEvent(event: RunProgressEvent): boolean {
  return isVisibleProgressEvent(event);
}

export function shouldKeepProgressOpenAfterResponse(
  openedByUser: boolean,
  currentlyOpen: boolean
): boolean {
  return openedByUser && currentlyOpen;
}

const VISIBLE_PROGRESS_LABELS = new Set([
  "research",
  "deterministic research",
  "query",
  "selected links",
  "evidence cards",
  "sufficiency",
  "candidate acquisition",
  "google",
  "search expansion",
  "first-pass review",
  "targeted second pass",
  "search provider",
  "safety",
  "coverage",
  "completion rule",
  "complete",
  "targeted expansion",
  "targeted search",
  "recovery search",
  "recovery coverage",
  "prequalify",
  "background prequalification",
  "visible rotation",
  "background google search",
  "background search scrape",
  "deepen",
  "scan",
  "warm",
  "draft synthesis",
  "evidence verification",
  "synthesis",
  "mixed plan",
  "browser research",
  "browser extract",
  "browser observe",
  "workspace status",
  "workspace list",
  "workspace search",
  "workspace read",
  "workspace write",
  "write confirmation",
  "blocked",
  "workspace synthesis",
  "model answer",
  "model turn",
  "current page",
  "current page answer",
  "browser tool",
  "browser search",
  "browser navigation",
  "browser action",
  "run failed",
  "run stopped",
  "unsupported capability"
]);

function updateRunStateFromProgress(
  event: RunProgressEvent,
  setRunState: (state: RunUiState) => void
): void {
  if (event.status === "paused") {
    setRunState("paused");
    return;
  }

  if (event.status === "stopped") {
    setRunState("stopping");
    return;
  }

  if (event.label === "Resumed" && event.status === "running") {
    setRunState("running");
  }
}

export function chatContextFromMessages(messages: ChatMessage[]): ChatContextMessage[] {
  const context: ChatContextMessage[] = [];

  for (const message of messages) {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      message.content === LEGACY_WELCOME_MESSAGE
    ) {
      continue;
    }

    if (message.status === "error") {
      if (context.at(-1)?.role === "user") {
        context.pop();
      }
      continue;
    }

    context.push({
      role: message.role === "user" ? "user" : "assistant",
      content: message.content
    });
  }

  return context.slice(-12);
}

async function sendRunMessage(
  request: RunRequest,
  onProgress?: (event: RunProgressEvent) => void,
  onControlsReady?: (controls: RunClientControls) => void,
  onAnswerDelta?: (delta: string) => void
): Promise<RunResponse> {
  if (onProgress && typeof chrome !== "undefined") {
    return sendRunPortMessage(request, onProgress, onControlsReady, onAnswerDelta);
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
  onProgress?: (event: RunProgressEvent) => void,
  onControlsReady?: (controls: RunClientControls) => void,
  onAnswerDelta?: (delta: string) => void
): Promise<RunResponse> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "ohmygod.run" });
    let settled = false;
    const postControl = (action: RunControlAction) => {
      if (!settled) {
        port.postMessage({ type: "ohmygod.control", action });
      }
    };

    onControlsReady?.({
      pause: () => postControl("pause"),
      resume: () => postControl("resume"),
      stop: () => postControl("stop")
    });

    port.onMessage.addListener((message: RunPortServerMessage) => {
      if (message.type === "ohmygod.progress") {
        onProgress?.(message.event);
        return;
      }

      if (message.type === "ohmygod.answer_delta") {
        onAnswerDelta?.(message.delta);
        return;
      }

      if (message.type === "ohmygod.keepalive") {
        return;
      }

      if (message.type === "ohmygod.done") {
        settled = true;
        port.disconnect();
        resolve(message.response);
        return;
      }

      if (message.type === "ohmygod.workspace_tool_request") {
        void executeBrowserToolLocally(message.call)
          .then((execution) => {
            const response: WorkspaceToolResponse = {
              type: "ohmygod.workspace_tool_response",
              requestId: message.requestId,
              execution
            };
            port.postMessage(response);
          })
          .catch((error) => {
            const response: WorkspaceToolResponse = {
              type: "ohmygod.workspace_tool_response",
              requestId: message.requestId,
              error: error instanceof Error ? error.message : "Workspace tool failed in the side panel."
            };
            port.postMessage(response);
          });
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
