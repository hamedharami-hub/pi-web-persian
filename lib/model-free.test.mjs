import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { isFreeModel } = await jiti.import("./model-free.ts");

test("detects free models from their zero token prices", () => {
  assert.equal(isFreeModel({ id: "local-model", cost: { input: 0, output: 0 } }), true);
  assert.equal(isFreeModel({ id: "cached-free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), true);
  assert.equal(isFreeModel({ id: "paid", cost: { input: 1, output: 2 } }), false);
  assert.equal(isFreeModel({ id: "free-cache", cost: { input: 0, output: 0, cacheRead: 0.25 } }), false);
});

test("recognizes an explicitly free model id when pricing is absent", () => {
  assert.equal(isFreeModel({ id: "vendor/model:free" }), true);
  assert.equal(isFreeModel({ id: "vendor/model:FREE" }), true);
  assert.equal(isFreeModel({ id: "vendor/model" }), false);
});
