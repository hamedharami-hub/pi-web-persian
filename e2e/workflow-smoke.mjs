// Isolated browser regression smoke: no live session, credentials, or provider calls.
// PI_WORKFLOW_BUILD_ROOT=/absolute/path/to/isolated/built/checkout node e2e/workflow-smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.PI_WORKFLOW_BUILD_ROOT, "Use an isolated prebuilt checkout, not the live service directory");
const root = resolve(process.env.PI_WORKFLOW_BUILD_ROOT);
assert.notEqual(root, repo, "Do not launch a test server inside the live checkout");
assert.ok(existsSync(join(root, ".next/BUILD_ID")), "Build the isolated checkout first");
const artifacts = mkdtempSync(join(tmpdir(), "pi-workflow-browser-"));
const agentDir = join(artifacts, "agent");
const project = join(artifacts, "project");
const sessionDir = join(agentDir, "sessions", "workflow");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(project);
mkdirSync(join(agentDir, "extensions"));
const extensionRoot = process.env.PI_WORKFLOW_EXTENSION_ROOT || "/home/ubuntu/.pi/agent/extensions";
cpSync(join(extensionRoot, "goal.ts"), join(agentDir, "extensions", "goal.ts"));
cpSync(join(extensionRoot, "plan-mode"), join(agentDir, "extensions", "plan-mode"), { recursive: true });
// Forbid a provider/network invocation even if a test accidentally sends a model prompt.
writeFileSync(join(agentDir, "extensions", "no-model.js"), `export default function(pi) {
  pi.on("before_agent_start", () => { throw new Error("WORKFLOW TEST: provider calls forbidden"); });
}`);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], subagents: { enabled: false } }));
const timestamp = new Date().toISOString();
const WORKFLOW = "workflow-browser-controls";
const INTERRUPTED = "workflow-browser-interrupted";
const msg = (id, parentId, role, content, extra = {}) => ({ type: "message", id, parentId, timestamp, message: { role, content, ...extra } });
function session(id, entries) {
  writeFileSync(join(sessionDir, `${id}.jsonl`), [{ type: "session", version: 3, id, timestamp, cwd: project }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
}
session(WORKFLOW, [
  msg("u1", null, "user", "برنامهٔ آزمایشی مرورگر"),
  msg("a1", "u1", "assistant", [{ type: "text", text: "برنامه:\n۱. بررسی خواندنی\n۲. تأیید نتیجه" }], { provider: "test", model: "offline", stopReason: "stop" }),
  { type: "custom", id: "plan1", parentId: "a1", timestamp, customType: "plan-mode", data: { enabled: false, executing: false, todos: [
    { step: 1, text: "بررسی خواندنی", completed: false }, { step: 2, text: "تأیید نتیجه", completed: false },
  ] } },
]);
session(INTERRUPTED, [
  msg("u1", null, "user", "آزمایش توقف بدون نتیجه"),
  msg("a1", "u1", "assistant", [{ type: "toolCall", id: "missing-result", name: "bash", arguments: { command: "echo never executed" } }], { provider: "test", model: "offline", stopReason: "toolUse" }),
]);

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done, reject) => probe.close(e => e ? reject(e) : done()));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(artifacts, "server.log"));
// Do not inherit the live agent directory, credentials, or model configuration.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI_|OPENAI_|ANTHROPIC_|AZURE_|OPENROUTER_|GOOGLE_|GEMINI_|DEEPSEEK_|XAI_)/.test(key)));
Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", PI_WEB_HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" });
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
let browser;
const results = [];
const failures = [];
try {
  for (let attempt = 0; ; attempt++) {
    assert.equal(server.exitCode, null, "Test server exited; see server.log");
    const response = await fetch(base + "/api/sessions", { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(attempt < 80, "Test server readiness timed out");
    await delay(250);
  }
  browser = await chromium.launch({ executablePath: process.env.PI_TEST_CHROME || "/opt/google/chrome/chrome", headless: true, args: ["--disable-dev-shm-usage"] });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const requests = [];
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/agent\/[^/]+$/.test(new URL(request.url()).pathname)) requests.push(request.postDataJSON());
    });
    // Reject any non-command prompt before dispatch, so no test can reach a model.
    await page.route("**/api/agent/*", async route => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        if (body.type === "prompt" && (!String(body.message).startsWith("/") || body.message === "/plan execute" || body.message === "/todos execute")) {
          await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "WORKFLOW TEST: model prompt intentionally intercepted", code: "prompt_rejected", accepted: false }) });
          return;
        }
      }
      await route.continue();
    });
    try {
      await page.goto(base + "/?session=" + WORKFLOW, { waitUntil: "domcontentloaded" });
      const planOff = page.getByRole("button", { name: "Plan OFF · toggle (/plan)", exact: true });
      await planOff.waitFor();

      const planPanel = page.locator(".extension-widget-panel.is-plan-todos");
      await planPanel.waitFor();
      assert.match(await planPanel.locator(".plan-widget-badge").innerText(), /Plan ready/);
      assert.equal(await planPanel.locator(".plan-widget-progress-text").innerText(), "0/2");
      assert.equal(await planPanel.locator(".plan-todo-list li").first().getAttribute("dir"), "auto");
      assert.equal(await page.getByRole("button", { name: "▶ Execute (/plan execute)", exact: true }).count(), 0, "Redundant status Execute button is hidden while plan panel is expanded");
      await planPanel.locator(".plan-widget-actions").getByRole("button", { name: "▶ Execute", exact: true }).waitFor();

      await page.getByRole("button", { name: "Toggle step 1", exact: true }).click();
      await planPanel.locator(".plan-widget-progress-text").filter({ hasText: "1/2" }).waitFor();
      await page.getByRole("button", { name: "Toggle step 1", exact: true }).click();
      await planPanel.locator(".plan-widget-progress-text").filter({ hasText: "0/2" }).waitFor();

      const planTrigger = page.locator('.extension-widget-trigger[aria-controls]').filter({ hasText: "plan-todos" });
      await planTrigger.click();
      await page.getByRole("button", { name: "▶ Execute (/plan execute)", exact: true }).waitFor();
      await planTrigger.click();
      await planPanel.waitFor();
      assert.equal(await page.getByRole("button", { name: "▶ Execute (/plan execute)", exact: true }).count(), 0);

      await planOff.click();
      const planOn = page.getByRole("button", { name: "Plan ON · toggle (/plan)", exact: true });
      await planOn.waitFor();
      await planOn.focus();
      await page.keyboard.press("Control+Alt+KeyP");
      await planOff.waitFor();
      assert.ok(await planPanel.locator(".plan-widget-actions").getByRole("button", { name: "▶ Execute", exact: true }).count(), "Saved checklist is still executable after off");
      results.push(`${viewport.width}px: real plan toggle, shortcut, checklist toggle, and status dedupe`);

      const goalButton = page.getByRole("button", { name: "◎ Set goal (/goal)", exact: true });
      await goalButton.click();
      const goalDialog = page.getByRole("dialog", { name: "Set focus goal (no automatic execution):", exact: true });
      await goalDialog.waitFor();
      await goalDialog.getByRole("textbox").fill("هدف آزمایشی بدون اجرای مدل");
      await goalDialog.getByRole("button", { name: "Submit", exact: true }).click();
      const editGoal = page.getByRole("button", { name: "◎ Edit goal · هدف آزمایشی بدون اجرای مدل (/goal)", exact: true });
      await editGoal.waitFor();
      await page.getByRole("button", { name: "🗺 Plan goal (/goal plan)", exact: true }).waitFor();
      const clearGoal = page.getByRole("button", { name: "✕ Clear goal (/goal clear)", exact: true });
      await clearGoal.waitFor();
      await editGoal.click();
      await goalDialog.waitFor();
      assert.equal(await goalDialog.getByRole("textbox").inputValue(), "هدف آزمایشی بدون اجرای مدل");
      await goalDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await goalDialog.waitFor({ state: "hidden" });
      results.push(`${viewport.width}px: real goal editor/save/prefill/cancel + goal chips`);
      await clearGoal.click();
      await goalButton.waitFor();

      await page.getByRole("button", { name: "📋 Todos (/todos)", exact: true }).click();
      const todos = page.getByRole("dialog", { name: "Plan todos — choose an action", exact: true });
      await todos.waitFor();
      await todos.getByRole("button", { name: "Status / close", exact: true }).click();
      await todos.waitFor({ state: "hidden" });
      assert.ok(await planPanel.locator(".plan-widget-actions").getByRole("button", { name: "▶ Execute", exact: true }).count());
      results.push(`${viewport.width}px: todos action selector cancel/close keeps steps`);

      // Reload also checks warm replay and clears transient command toasts that
      // intentionally overlap the topmost message in this short fixture.
      await page.reload({ waitUntil: "domcontentloaded" });
      await planOff.waitFor();
      await page.getByText("برنامهٔ آزمایشی مرورگر", { exact: true }).last().hover();
      await page.getByRole("button", { name: "Edit from here", exact: true }).first().click();
      assert.equal(await goalButton.isDisabled(), true, "Goal button cannot navigate a historical edit");
      assert.equal(await planOff.isDisabled(), true, "Plan button cannot navigate a historical edit");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await planOff.waitFor();
      assert.equal(await planOff.isEnabled(), true);
      results.push(`${viewport.width}px: status commands disabled while editing history`);
      if (viewport.width > 600) {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("radio", { name: /فارسی/ }).click();
        await page.getByRole("dialog", { name: "تنظیمات", exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.lang), "fa");
        await page.getByRole("button", { name: "بستن", exact: true }).click();
        await planPanel.waitFor();
        await planPanel.locator(".plan-widget-actions").getByRole("button", { name: "⚡ خودکار", exact: true }).waitFor();
        await page.getByRole("button", { name: "ارسال", exact: true }).waitFor();
        await page.getByRole("button", { name: "تنظیمات", exact: true }).click();
        await page.getByRole("radio", { name: /English/ }).click();
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        results.push(`${viewport.width}px: fa locale renders Persian workflow & composer UI cleanly`);

        const beforeDebug = requests.length;
        const debug = page.getByRole("button", { name: "Debug", exact: true });
        await debug.click();
        const panel = page.getByRole("region", { name: "Debug: connections and server state", exact: true });
        await panel.waitFor();
        await page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent/debug" && response.status() === 200);
        assert.equal(requests.length, beforeDebug, "Debug must not dispatch commands");
        await debug.click();
        await panel.waitFor({ state: "hidden" });
        results.push(`${viewport.width}px: Debug opens read-only and sends no agent command`);
      }

      await page.screenshot({ path: join(artifacts, `workflow-${viewport.width}.png`) });
      await page.goto(base + "/?session=" + INTERRUPTED, { waitUntil: "domcontentloaded" });
      await page.getByText(/The run ended without a recorded tool result/).waitFor();
      const proceed = page.getByRole("button", { name: "Check state and continue", exact: true });
      await proceed.waitFor();
      const callsBefore = requests.filter(r => r.type === "prompt").length;
      await page.waitForTimeout(500);
      assert.equal(requests.filter(r => r.type === "prompt").length, callsBefore, "No automatic retry of interrupted command");
      const tool = page.locator('button').filter({ hasText: "echo never executed" }).first();
      await tool.waitFor();
      const color = await tool.locator('span').first().evaluate(element => getComputedStyle(element).color);
      assert.notEqual(color, "rgb(22, 163, 74)", "Missing result is not shown as green success");
      await page.screenshot({ path: join(artifacts, `interrupted-${viewport.width}.png`) });
      results.push(`${viewport.width}px: interrupted banner/no automatic retry/neutral tool`);
      assert.deepEqual(errors, [], "No uncaught browser errors");
    } catch (error) {
      failures.push({ viewport: viewport.width, error: String(error), browserErrors: errors });
      await page.screenshot({ path: join(artifacts, `failure-${viewport.width}.png`) }).catch(() => {});
      writeFileSync(join(artifacts, `failure-${viewport.width}.txt`), await page.locator("body").innerText().catch(() => ""));
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  if (server.exitCode === null) await Promise.race([once(server, "exit"), delay(10000)]);
  log.end();
  writeFileSync(join(artifacts, "result.json"), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ artifacts, results, failures }, null, 2));
}
assert.deepEqual(failures, [], "Browser workflow checks failed; inspect isolated artifacts");
