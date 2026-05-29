import { chromium, expect, type Page, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(repoRoot, "dist");
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? chromium.executablePath();

test("surfaces run progress, failed answers, and activity details from the extension port", async () => {
  test.skip(!existsSync(path.join(extensionPath, "manifest.json")), "Run npm run build before extension smoke tests.");
  test.skip(!existsSync(chromiumExecutablePath), "Run npx playwright install chromium before extension smoke tests.");

  const userDataDir = await mkdtemp(path.join(tmpdir(), "ohmygod-extension-progress-"));
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
    await expect(page.getByPlaceholder("Message the assistant")).toBeVisible();

    await page.getByRole("textbox", { name: "Anthropic API key" }).fill("test-anthropic-key");
    const saveAnthropicKey = page.getByRole("button", { name: "Save Anthropic API key" });
    await saveAnthropicKey.click();
    await expect(saveAnthropicKey).toContainText("Saved");

    await installFakeRunPort(page);

    await page.getByPlaceholder("Message the assistant").fill("Try an unsupported browser action");
    await page.getByPlaceholder("Message the assistant").press("Enter");

    const progressCard = page.locator("#research-progress-card");
    const progressTab = page.locator(".research-progress-tab");
    await expect(progressCard).not.toHaveClass(/open/);
    await expect(progressTab).toHaveAttribute("aria-expanded", "false");
    await progressTab.click();
    await expect(progressCard).toHaveClass(/open/);
    await expect(progressTab).toHaveAttribute("aria-expanded", "true");
    await expect(progressCard.locator(".research-progress-title")).toContainText("Progress");
    await expect(progressCard).toContainText("Running browser_extract_page.");
    await expect(progressCard).toContainText("Extracted page fixture.");
    await expect(progressCard).toContainText("Closing tabs is not supported by the loaded tool contract.");
    await expect(progressCard).toContainText("1 flagged");

    await expect(page.getByText("I could not complete that request because closing tabs is not supported by the loaded tool contract.")).toBeVisible();
    await expect(page.getByText("Unsupported capability: tab closing.").first()).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Activity (1)" }).click();
    const activityDrawer = page.locator("#activity-drawer");
    await expect(activityDrawer).toHaveAttribute("aria-hidden", "false");
    await expect(activityDrawer).toContainText("Unsupported request");
    await expect(activityDrawer).toContainText("Blocked unsupported tab closing before execution.");
    await expect(activityDrawer).toContainText("Unsupported capability: tab closing.");

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

async function installFakeRunPort(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = chrome.runtime as unknown as {
      connect: (connectInfo?: chrome.runtime.ConnectInfo) => chrome.runtime.Port;
    };
    const originalConnect = chrome.runtime.connect.bind(chrome.runtime);

    runtime.connect = (connectInfo?: chrome.runtime.ConnectInfo) => {
      if (connectInfo?.name !== "ohmygod.run") {
        return originalConnect(connectInfo);
      }

      const messageListeners: Array<(message: unknown) => void> = [];
      const disconnectListeners: Array<() => void> = [];
      const emit = (message: unknown) => {
        for (const listener of [...messageListeners]) {
          listener(message);
        }
      };
      const now = () => new Date().toISOString();
      const fakePort = {
        name: "ohmygod.run",
        onMessage: {
          addListener: (listener: (message: unknown) => void) => {
            messageListeners.push(listener);
          }
        },
        onDisconnect: {
          addListener: (listener: () => void) => {
            disconnectListeners.push(listener);
          }
        },
        postMessage: (message: unknown) => {
          if (!message || (message as { type?: unknown }).type !== "ohmygod.run") {
            return;
          }

          const startedAt = now();
          const completedAt = now();
          const progressEvents = [
            {
              id: "progress-model-running",
              timestamp: startedAt,
              level: "info",
              label: "Model turn",
              detail: "Planning browser step.",
              status: "running",
              startedAt
            },
            {
              id: "progress-extract-running",
              timestamp: startedAt,
              level: "info",
              label: "Browser extract",
              detail: "Running browser_extract_page.",
              status: "running",
              startedAt
            },
            {
              id: "progress-extract-completed",
              timestamp: completedAt,
              level: "info",
              label: "Browser extract",
              detail: "Extracted page fixture.",
              status: "completed",
              startedAt,
              endedAt: completedAt,
              durationMs: 18
            },
            {
              id: "progress-unsupported-failed",
              timestamp: completedAt,
              level: "warning",
              label: "Unsupported capability",
              detail: "Closing tabs is not supported by the loaded tool contract.",
              status: "failed",
              startedAt,
              endedAt: completedAt,
              durationMs: 1
            }
          ];

          progressEvents.forEach((event, index) => {
            window.setTimeout(() => emit({ type: "ohmygod.progress", event }), index * 5);
          });
          window.setTimeout(() => {
            emit({
              type: "ohmygod.done",
              response: {
                ok: false,
                answer: "I could not complete that request because closing tabs is not supported by the loaded tool contract.",
                error: "Unsupported capability: tab closing.",
                activity: [
                  {
                    id: "activity-unsupported",
                    timestamp: completedAt,
                    level: "warning",
                    label: "Unsupported capability",
                    details: "Closing tabs is not supported by the loaded tool contract.",
                    toolName: "Router",
                    actionLabel: "Unsupported request",
                    status: "failed",
                    eventType: "failure",
                    resultSummary: "Blocked unsupported tab closing before execution.",
                    warning: "Unsupported capability: tab closing.",
                    startedAt,
                    endedAt: completedAt,
                    durationMs: 1
                  }
                ]
              }
            });
          }, progressEvents.length * 5);
        },
        disconnect: () => {
          for (const listener of [...disconnectListeners]) {
            listener();
          }
        }
      };

      return fakePort as chrome.runtime.Port;
    };
  });
}
