import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { getTurnSettlementOutcome } from "../lib/turn-completion.ts";
import { isMessageGroupAnchor } from "../lib/message-display.ts";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name) {
  const node = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
function setup(state, running = true, savedMessages = [{ role: "user", content: "start" }, { role: "assistant", content: [{ type: "text", text: "Verified answer" }], stopReason: "stop" }]) {
  const notices = [], completions = [], reads = [];
  const context = createContext({
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "a" }, promptRunIdRef: { current: 1 },
    sessionReadSeqRef: { current: 0 }, lastReadContextRef: { current: null }, agentRunningRef: { current: true },
    getTurnSettlementOutcome, isMessageGroupAnchor, runTranscriptBaselineRef: { current: null },
    rpcPromptPendingRef: { current: true }, sdkAgentActiveRef: { current: true },
    optimisticUserMessageKeyRef: { current: "prompt" }, contextUsageRequestIdRef: { current: 0 },
    // v0.17.0's unconfirmed-send settlement: no send is parked here, so nothing
    // is restored to the composer and the run settles through its transcript.
    unconfirmedSendRef: { current: null },
    settleUnconfirmedSend: () => false, dropUnconsumedCommandBubble() {},
    loadSession: async (sid) => { reads.push(sid); context.lastReadContextRef.current = { sid, seq: ++context.sessionReadSeqRef.current, messages: savedMessages, entryIds: savedMessages.map((_, i) => `entry-${i}`) }; }, settleUnconfirmedSend() {},
    settleUiStage: () => { const was = context.agentRunningRef.current; context.agentRunningRef.current = false; return was; },
    addNotice: (notice) => notices.push(notice), translate: (key) => key,
    notifyPromptStage: (_run, aborted) => completions.push(aborted), onAgentEnd: (info) => completions.push(info.aborted),
    scheduleEventStreamClose() {}, agentStatusUrl: (sid) => `/api/agent/${sid}`,
    AGENT_STATUS_TIMEOUT_MS: 8_000,
    fetch: async () => ({ ok: true, json: async () => ({ running, state }) }),
    fetchWithTimeout: (input, init) => context.fetch(input, init),
    applyLiveUsage() {}, applyLoadedExtensionUiState() {}, syncLiveModel() {}, setIsCompacting() {}, setAutoCompactionEnabled() {},
    setQueuedMessages() {}, normalizeQueuedMessages: (value) => value,
    setExtensionStatuses() {}, setExtensionWidgets() {}, setSystemPrompt() {},
  });
  context.finishPromptWithoutStream = callback("finishPromptWithoutStream").runInContext(context);
  context.reconcileAgentState = callback("reconcileAgentState").runInContext(context);
  return { context, notices, completions, reads };
}

test("lost runtime is visibly interrupted and never gets a successful completion notification", async () => {
  const s = setup(undefined, false);
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices.length, 1);
  assert.equal(s.notices[0].type, "warning");
  assert.equal(s.notices[0].message, "chat.runUnavailable");
  assert.deepEqual(s.reads, ["a"]);
  assert.equal(s.context.agentRunningRef.current, false);
  await s.context.reconcileAgentState("a");
  assert.equal(s.notices.length, 1);
});

test("an idle but available runtime still settles normally", async () => {
  const s = setup({ isStreaming: false, isPromptRunning: false, isCompacting: false });
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [false]);
  assert.deepEqual(s.notices, []);
});

test("SSE recreates an idle wrapper before reconciliation: the saved dangling call is still interrupted", async () => {
  const messages = [
    { role: "user", content: "start" },
    { role: "assistant", content: [{ type: "text", text: "Starting now" }], stopReason: "stop" },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "restart", toolName: "bash", input: {} }], stopReason: "toolUse" },
  ];
  const s = setup({ isStreaming: false, isPromptRunning: false }, true, messages);
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.missingToolResult");
});

test("completed tools without a final answer are not announced as successful completion", async () => {
  const s = setup({ isStreaming: false }, true, [
    { role: "user", content: "start" },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "a" }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "a", content: [] },
  ]);
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.noFinalResponse");
});

test("a stale or failed history read never becomes proof of success", async () => {
  const s = setup({ isStreaming: false });
  s.context.loadSession = async () => {};
  s.context.lastReadContextRef.current = { sid: "a", seq: 0, messages: [{ role: "assistant", content: [], stopReason: "stop" }], entryIds: ["old"] };
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.runOutcomeUnknown");
});

test("settlement requests a fresh read instead of joining an existing history flight", async () => {
  const s = setup({ isStreaming: false });
  let options;
  const load = s.context.loadSession;
  s.context.loadSession = async (...args) => { options = args[3]; return load(...args); };
  await s.context.reconcileAgentState("a");
  assert.equal(options.force, true);
  assert.deepEqual(s.completions, [false]);
});

test("a slash command with no model run is not blamed for an older dangling tool", async () => {
  const s = setup({ isStreaming: false }, true, [
    { role: "user", content: "old prompt" },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "old" }] },
  ]);
  s.context.runTranscriptBaselineRef.current = { runId: 1, entryId: "entry-1", command: true, modelStarted: false };
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [false]);
  assert.deepEqual(s.notices, []);
});

test("a command that actually starts the model does inspect its new transcript", async () => {
  const s = setup({ isStreaming: false }, true, [
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "new" }] },
  ]);
  s.context.runTranscriptBaselineRef.current = { runId: 1, entryId: "entry-0", command: true, modelStarted: true };
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.missingToolResult");
});

test("a slash command's model start can be missed by SSE: new transcript still overrides modelStarted=false", async () => {
  const s = setup({ isStreaming: false }, true, [
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "new" }] },
  ]);
  s.context.runTranscriptBaselineRef.current = { runId: 1, entryId: "entry-0", command: true, modelStarted: false };
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.missingToolResult");
});

test("a slash command with an unverifiable history does not announce success", async () => {
  const s = setup({ isStreaming: false });
  s.context.runTranscriptBaselineRef.current = { runId: 1, entryId: "entry-0", command: true, modelStarted: false };
  s.context.loadSession = async () => {};
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.runOutcomeUnknown");
});

test("stored aborted, error or length outcomes never announce success even when display notices are suppressed", async () => {
  for (const stopReason of ["aborted", "error", "length"]) {
    const s = setup({ isStreaming: false }, true, [{ role: "assistant", stopReason, content: [] }]);
    await s.context.reconcileAgentState("a");
    assert.deepEqual(s.completions, [true], stopReason);
    assert.deepEqual(s.notices, [], "existing message notice is not duplicated");
  }
});

test("a snapshot missing the current send's baseline cannot certify completion", async () => {
  const s = setup({ isStreaming: false });
  s.context.runTranscriptBaselineRef.current = { runId: 1, entryId: "not-in-loaded-window", command: false, modelStarted: true };
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
  assert.equal(s.notices[0].message, "chat.runOutcomeUnknown");
});

test("a busy or compacting runtime is never settled", async () => {
  for (const state of [{ isStreaming: true }, { isPromptRunning: true }, { isCompacting: true }]) {
    const s = setup(state);
    await s.context.reconcileAgentState("a");
    assert.deepEqual(s.completions, []);
    assert.deepEqual(s.reads, []);
    assert.equal(s.context.agentRunningRef.current, true);
  }
});

test("extension-started runs also suppress the success chime when runtime disappears", async () => {
  const s = setup(undefined, false);
  s.context.rpcPromptPendingRef.current = false;
  await s.context.reconcileAgentState("a");
  assert.deepEqual(s.completions, [true]);
});

test("stale settlement cannot update another run, session, or unmounted view", async () => {
  for (const invalidate of [
    (ctx) => { ctx.promptRunIdRef.current++; },
    (ctx) => { ctx.sessionIdRef.current = "b"; },
    (ctx) => { ctx.sessionHookMountedRef.current = false; },
  ]) {
    const s = setup(undefined, false);
    const load = Promise.withResolvers();
    s.context.loadSession = () => load.promise;
    const settling = s.context.finishPromptWithoutStream("a", 1, true);
    invalidate(s.context);
    load.resolve(); await settling;
    assert.deepEqual(s.completions, []);
    assert.deepEqual(s.notices, []);
  }
});

test("lost runtime responses from an older run cannot settle a newer one", async () => {
  const s = setup(undefined, false);
  const response = Promise.withResolvers();
  s.context.fetch = () => response.promise;
  const check = s.context.reconcileAgentState("a");
  s.context.promptRunIdRef.current++;
  response.resolve({ ok: true, json: async () => ({ running: false }) });
  await check;
  assert.deepEqual(s.completions, []);
  assert.deepEqual(s.notices, []);
});
