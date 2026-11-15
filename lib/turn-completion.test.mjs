import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { getIncompleteTurnReason, toolResultColors } from "./turn-completion.ts";

const text = (text) => ({ type: "text", text });
const call = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: {} });
const assistant = (content, stopReason = "toolUse") => ({ role: "assistant", content, stopReason, provider: "test", model: "test" });
const result = (id, isError = false) => ({ role: "toolResult", toolCallId: id, isError, content: [text("ok")] });
const user = { role: "user", content: "start" };
const reason = (messages) => getIncompleteTurnReason(messages, 0, messages.length);

test("self-host restart snapshot: a persisted tool call without its result is unknown, not success", () => {
  const messages = [user, assistant([call("probe")]), result("probe"), assistant([call("restart")])];
  assert.equal(reason(messages), "missing_tool_result");
});

test("tool result without a final answer and reasoning-only stops get a visible outcome", () => {
  assert.equal(reason([user, assistant([call("a")]), result("a")]), "no_final_response");
  assert.equal(reason([user, assistant([{ type: "thinking", thinking: "hmm" }], "stop")]), "no_final_response");
  assert.equal(reason([user, assistant([], "stop")]), "no_final_response");
  assert.equal(reason([user, assistant([text("Starting"), call("a")]), result("a")]), "no_final_response");
});

test("actual final answers are not marked incomplete; custom hidden reminders change nothing", () => {
  const done = [user, assistant([call("a")]), result("a"), assistant([text("Done, verified")], "stop")];
  assert.equal(reason(done), null);
  assert.equal(reason([...done, { role: "custom", customType: "focus-goal-context", display: false, content: "goal" }]), null);
  assert.equal(reason([user, assistant([{ type: "image", source: {} }], "stop")]), null);
  assert.equal(reason([user, assistant([call("a"), text("Final result")]), result("a")]), null);
});

test("each parallel tool result must be present and errors are not missing results", () => {
  const messages = [user, assistant([call("a"), call("b")]), result("a")];
  assert.equal(reason(messages), "missing_tool_result");
  messages.push(result("b", true));
  assert.equal(reason(messages), "no_final_response");
  messages.push(assistant([text("Tool failed; stopped safely")], "stop"));
  assert.equal(reason(messages), null);
});

test("existing error, truncation, and deliberately aborted notices are not duplicated", () => {
  for (const stop of ["error", "length", "aborted"]) {
    assert.equal(reason([user, assistant([], stop)]), null);
  }
  assert.equal(reason([user]), null);
  assert.equal(reason([{ role: "bashExecution", command: "echo hi", output: "hi" }]), null);
});

test("a later user's completed turn cannot hide an earlier interruption", () => {
  const messages = [user, assistant([call("a")]), user, assistant([text("New answer")], "stop")];
  assert.equal(getIncompleteTurnReason(messages, 0, 2), "missing_tool_result");
  assert.equal(getIncompleteTurnReason(messages, 2, 4), null);
});

test("tool card remains neutral until a result arrives; errors stay red", () => {
  assert.equal(toolResultColors(undefined, false).text, "var(--text-muted)");
  assert.equal(toolResultColors(result("a"), false, true).text, "var(--text-muted)");
  assert.equal(toolResultColors({ ...result("a"), toolName: "bash", isPartial: true }, false).text, "var(--text-muted)");
  assert.equal(toolResultColors({ ...result("a"), toolName: "powershell", isPartial: true }, false).text, "var(--text-muted)");
  assert.equal(toolResultColors(result("a"), false).text, "#16a34a");
  assert.equal(toolResultColors(result("a", true), true).text, "#f87171");
});

test("the real continuation click cannot submit while editing a historical entry", async () => {
  const source = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === "onClick" && node.initializer?.expression && node.initializer.expression.getText(ast).includes('handleSend(t("chat.inspectBeforeContinuePrompt"))')) handler = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler);
  const script = new Script(ts.transpileModule(`(${handler.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const flags of [{ editEntryId: "old-entry" }, { sessionBusy: true }, { isStreaming: true }, { isCompacting: true }, {}]) {
    const sent = [];
    const ctx = createContext({ sessionBusy: false, isStreaming: false, isCompacting: false, editEntryId: null, ...flags, t: (key) => key, handleSend: (value) => sent.push(value) });
    script.runInContext(ctx)();
    assert.equal(sent.length, Object.keys(flags).length ? 0 : 1);
  }
});

test("status commands cannot navigate a historical edit or run during compaction", async () => {
  const source = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === "onCommand" && node.initializer?.expression && node.initializer.expression.getText(ast).includes("handleSend(command")) handler = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler);
  const script = new Script(ts.transpileModule(`(${handler.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  for (const flags of [{ editEntryId: "old-entry" }, { sessionBusy: true }, { isStreaming: true }, { isCompacting: true }, {}]) {
    const sent = [];
    const ctx = createContext({ sessionBusy: false, isStreaming: false, isCompacting: false, editEntryId: null, ...flags, handleSend: (value) => sent.push(value) });
    script.runInContext(ctx)("/goal");
    assert.deepEqual(sent, Object.keys(flags).length ? [] : ["/goal"]);
  }
});

test("chat integration excludes live turns and only offers explicit guarded continuation at the tail", async () => {
  const source = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  const live = source.indexOf("if (isLiveTail)");
  const notice = source.indexOf("const incomplete = !loading ? getIncompleteTurnReason(");
  assert.ok(live > 0 && notice > live);
  assert.match(source, /endIdx === messages.length && \(\s*<button type="button" disabled=\{sessionBusy \|\| isStreaming \|\| isCompacting \|\| Boolean\(editEntryId\)\}/);
  assert.match(source, /onClick=\{\(\) => \{ if \(!sessionBusy && !isStreaming && !isCompacting && !editEntryId\) void handleSend\(t\("chat.inspectBeforeContinuePrompt"\)\)/);
  const messageView = await readFile(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageView, /toolResultColors\(result, isError, codemodeRunning\)/);
  assert.match(messageView, /background: colors.background/);
});
