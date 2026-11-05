import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = readFileSync(new URL("./SessionChatPanel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function harness(responses, running = true) {
  const states = [];
  let index = 0, effect, deps, cleanup, timer, calls = 0;
  const hooks = {
    useState(initial) {
      const i = index++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (value) => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
    },
    useRef(initial) { const i = index++; return states[i] ??= { current: initial }; },
    useEffect(callback, next) {
      if (!deps || next.some ( (value, i) => value !== deps[i])) { effect = callback; deps = next; }
    },
  };
  const exports = {};
  const context = vm.createContext({
    exports, AbortController,
    fetch: async () => { calls++; const response = responses.shift(); if (response instanceof Error) throw response; return response; },
    setTimeout: (callback) => { timer = callback; return callback; },
    clearTimeout: (id) => { if (timer === id) timer = undefined; },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: React.createElement, jsxs: React.createElement };
      if (name === "@/hooks/useI18n") return { useI18n: () => ({ t: (key) => key }) };
      if (name === "./ChatWindow") return { ChatWindow: () => React.createElement("div", null, "chat") };
      throw new Error(name);
    },
  });
  vm.runInContext(code, context);
  function render() {
    index = 0;
    const element = exports.SessionChatPanel({ sessionId: "a/b", running });
    if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; }
    return element;
  }
  return { render, runTimer: () => { const fn = timer; timer = undefined; assert.ok(fn); fn(); }, hasTimer: () => !!timer, calls: () => calls, dispose: () => cleanup?.() };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (status, body) => new Response(JSON.stringify(body), { status });

test("running errors are visible and automatically recover; cleanup cancels retries", async () => {
  const h = harness([response(500, { info: { id: "wrong" } }), response(200, { info: { id: "ok" } })]);
  h.render(); await flush();
  const error = h.render();
  assert.match(renderToStaticMarkup(error), /role="alert".*sessionPanel.error.*sessionPanel.retry/);
  assert.ok(h.hasTimer());
  h.runTimer(); await flush();
  assert.match(renderToStaticMarkup(h.render()), /chat/);
  assert.equal(h.calls(), 2);
  h.dispose();
});

test("missing running sessions retry, network errors can be retried manually and cleanup cancels timers", async () => {
  const h = harness([response(404, {}), new Error("offline"), response(200, { info: { id: "ok" } })]);
  h.render(); await flush();
  assert.match(renderToStaticMarkup(h.render()), /sessionPanel.loading/);
  h.runTimer(); await flush();
  const error = h.render();
  assert.match(renderToStaticMarkup(error), /sessionPanel.error/);
  error.props.children[1].props.children.props.onClick();
  assert.match(renderToStaticMarkup(h.render()), /sessionPanel.loading/);
  assert.equal(h.hasTimer(), false);
  await flush();
  assert.match(renderToStaticMarkup(h.render()), /chat/);
  h.dispose();
});

test("unmount cancels a pending retry", async () => {
  const h = harness([response(200, {})]);
  h.render(); await flush();
  assert.match(renderToStaticMarkup(h.render()), /sessionPanel.error/);
  h.dispose();
  assert.equal(h.hasTimer(), false);
});
