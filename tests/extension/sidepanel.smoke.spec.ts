import { chromium, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionPath = path.join(repoRoot, "dist");
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? chromium.executablePath();

test("loads the unpacked extension side panel shell", async () => {
  test.skip(!existsSync(path.join(extensionPath, "manifest.json")), "Run npm run build before extension smoke tests.");
  test.skip(!existsSync(chromiumExecutablePath), "Run npx playwright install chromium before extension smoke tests.");

  const userDataDir = await mkdtemp(path.join(tmpdir(), "ohmygod-extension-"));
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
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(page.getByLabel("API keys")).toBeVisible();

    await page.getByPlaceholder("Message the assistant").fill("hello");
    await page.getByPlaceholder("Message the assistant").press("Enter");
    await expect(page.getByText("Add an Anthropic API key in Settings before using the assistant.").first()).toBeVisible();

    await page.getByRole("button", { name: "Chats" }).click();
    await expect(page.getByLabel("Chat history")).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    const settingsDialog = page.getByRole("dialog", { name: "Settings" });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByLabel("Anthropic API key")).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
