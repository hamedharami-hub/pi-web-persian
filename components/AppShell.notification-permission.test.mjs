import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("AppShell.tsx", await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "deliverSessionNotification") declaration = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(declaration);
const script = new Script(ts.transpileModule(`(${declaration.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);

test("background completions never request notification access; only previously granted access delivers", () => {
  for (const permission of ["default", "denied", "granted"]) {
    const sent = [], push = [];
    let asked = 0;
    const Notification = { permission, requestPermission: () => { asked++; return Promise.resolve("granted"); } };
    const context = createContext({ window: { Notification, focus() {} }, Notification,
      showBrowserNotification: (value) => { sent.push(value); return Promise.resolve(); },
      setupPushSubscription: (locale) => { push.push(locale); return Promise.resolve(); },
      locale: "en", handleSelectSession() {}, encodeURIComponent,
    });
    script.runInContext(context)({ targetSession: { id: "test" }, title: "Done", body: "Details", tag: "test" });
    assert.equal(asked, 0, permission);
    assert.equal(sent.length, permission === "granted" ? 1 : 0, permission);
    assert.equal(push.length, permission === "granted" ? 1 : 0, permission);
  }
});

test("unsupported notifications are harmless and explicit registration remains in Settings", async () => {
  script.runInNewContext({ window: {} })({ targetSession: null, title: "Done", body: "Details" });
  const settings = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settings, /Notification\.requestPermission\(\)/);
});
