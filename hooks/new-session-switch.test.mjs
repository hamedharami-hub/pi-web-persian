import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// A fresh composer's first send, with the user switching to another session at
// each step of its startup (#1146). Switching unmounts the composer, which
// closes its event stream; the prompt must still reach the new session.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

async function sendAndSwitch(stage) {
  const creation = Promise.withResolvers();
  const acceptance = Promise.withResolvers();
  const commands = [];
  const sources = [];
  const created = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return creation.promise;
    if (url === "/api/agent/s1" && command) {
      commands.push(command.type);
      return command.type === "prompt" ? acceptance.promise : json({ success: true });
    }
    if (url === "/api/agent/s1") return json({ running: true, state: { isStreaming: true, isPromptRunning: true } });
    throw new Error(`unexpected fetch ${url} ${init.body ?? ""}`);
  };

  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onSessionCreated: (session) => created.push(session.id),
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sending = hook.result.handleSend("first message");
    await settle();
    if (stage === "creating") hook.unmount();
    creation.resolve(json({ sessionId: "s1" }));
    await settle();
    if (stage === "connecting") hook.unmount();
    else sources.at(-1)?.connect();
    await settle();
    if (stage === "prompting") hook.unmount();
    acceptance.resolve(json({ success: true, data: null }));
    await sending;
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
  }
  if (stage === "mounted") hook.unmount();
  return { commands, created, opened: sources.length };
}

for (const stage of ["mounted", "creating", "connecting", "prompting"]) {
  test(`a first prompt reaches its new session when the user switches away (${stage})`, async () => {
    const result = await sendAndSwitch(stage);
    assert.deepEqual(result.commands, ["prompt"]);
    assert.deepEqual(result.created, ["s1"]);
  });
}

test("a composer unmounted before its session exists opens no event stream for it", async () => {
  assert.equal((await sendAndSwitch("creating")).opened, 0);
  assert.equal((await sendAndSwitch("mounted")).opened, 1);
});

test("status-bar command /todos refine promotes an isNew session when agent_start arrives", async () => {
  const created = [];
  const commands = [];
  const sources = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return json({ sessionId: "s1" });
    if (url === "/api/agent/s1" && command) {
      commands.push({ type: command.type, message: command.message });
      return json({ success: true, data: null });
    }
    if (url === "/api/agent/s1") return json({ running: true, state: { isStreaming: true, isPromptRunning: true } });
    throw new Error(`unexpected fetch ${url} ${init.body ?? ""}`);
  };

  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onSessionCreated: (session) => created.push(session),
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sending = hook.result.handleSend("/todos refine", undefined, { fromStatusBar: true });
    await settle();
    sources.at(-1)?.connect();
    await sending;
    await settle();

    // Agent begins running the extension command prompt -> session must promote to sidebar
    sources.at(-1)?.emit({ type: "agent_start" });
    await settle();
    hook.flush();

    // Repeating agent_start must not duplicate onSessionCreated
    sources.at(-1)?.emit({ type: "agent_start" });
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
    hook.unmount();
  }

  assert.equal(commands.some((c) => c.type === "prompt" && c.message === "/todos refine"), true);
  assert.deepEqual(created.map((s) => s.id), ["s1"]);
});
