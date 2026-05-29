import { chromium, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(repoRoot, "dist");
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? chromium.executablePath();

test("streams real service-worker progress over the extension run port without live model calls", async () => {
  test.skip(!existsSync(path.join(extensionPath, "manifest.json")), "Run npm run build before extension smoke tests.");
  test.skip(!existsSync(chromiumExecutablePath), "Run npx playwright install chromium before extension smoke tests.");

  const userDataDir = await mkdtemp(path.join(tmpdir(), "ohmygod-serviceworker-progress-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(`chrome-extension://${extensionId}/src/app/index.html`);

    const trace = await page.evaluate(() =>
      new Promise<{
        messageTypes: string[];
        progress: Array<{
          label?: string;
          detail?: string;
          status?: string;
          level?: string;
          sourceQuality?: string;
        }>;
        response?: {
          ok?: boolean;
          answer?: string;
          error?: string;
          activity?: Array<{
            label?: string;
            toolName?: string;
            actionLabel?: string;
            status?: string;
            details?: string;
            warning?: string;
          }>;
        };
      }>((resolve, reject) => {
        const messageTypes: string[] = [];
        const progress: Array<{
          label?: string;
          detail?: string;
          status?: string;
          level?: string;
          sourceQuality?: string;
        }> = [];
        const port = chrome.runtime.connect({ name: "ohmygod.run" });
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            port.disconnect();
            reject(new Error("Timed out waiting for service worker run response."));
          }
        }, 10_000);

        port.onMessage.addListener((message: unknown) => {
          const typed = message as {
            type?: string;
            event?: {
              label?: string;
              detail?: string;
              status?: string;
              level?: string;
              sourceQuality?: string;
            };
            response?: {
              ok?: boolean;
              answer?: string;
              error?: string;
              activity?: Array<{
                label?: string;
                toolName?: string;
                actionLabel?: string;
                status?: string;
                details?: string;
                warning?: string;
              }>;
            };
          };
          if (typed.type) {
            messageTypes.push(typed.type);
          }

          if (typed.type === "ohmygod.progress" && typed.event) {
            progress.push(typed.event);
            return;
          }

          if (typed.type === "ohmygod.done") {
            settled = true;
            window.clearTimeout(timeoutId);
            const response = typed.response;
            port.disconnect();
            resolve({ messageTypes, progress, response });
          }
        });

        port.onDisconnect.addListener(() => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeoutId);
            reject(new Error(chrome.runtime.lastError?.message ?? "Run port disconnected before completion."));
          }
        });

        port.postMessage({
          type: "ohmygod.run",
          message: "Close all my tabs.",
          settings: {
            provider: {
              provider: "anthropic",
              apiKey: "",
              geminiApiKey: "",
              openaiApiKey: ""
            },
            model: {
              model: "claude-haiku-4-5-20251001",
              researchSynthesisModel: "auto",
              temperature: 0.2,
              maxOutputTokens: 1600
            },
            dev: {
              permissiveExecution: true,
              showDebugLogs: false,
              showEvidencePreview: false
            }
          },
          history: []
        });
      })
    );

    expect(trace.messageTypes).toEqual(["ohmygod.progress", "ohmygod.done"]);
    expect(trace.progress).toContainEqual(expect.objectContaining({
      label: "Unsupported capability",
      level: "warning",
      status: "failed",
      sourceQuality: "blocked"
    }));
    expect(trace.progress[0]?.detail).toContain("does not currently support close tab actions");

    expect(trace.response?.ok).toBe(false);
    expect(trace.response?.answer).toContain("does not currently support close tab actions");
    expect(trace.response?.error).toContain("does not currently support close tab actions");
    expect(trace.response?.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Master router",
        toolName: "heuristic-master-router",
        actionLabel: "Route request",
        status: "failed"
      }),
      expect.objectContaining({
        label: "Unsupported capability",
        toolName: "master-router",
        actionLabel: "Unsupported request",
        status: "failed"
      })
    ]));

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
