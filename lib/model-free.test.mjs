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

test("excludes personal models.json Google accounts even when cost is zero", () => {
  assert.equal(isFreeModel({
    id: "gemini-4-argon",
    provider: "haramipourhamedgemini",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    isCustomProvider: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }), false);

  assert.equal(isFreeModel({
    id: "gemma-4-31b-it",
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    isCustomProvider: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }), true);
});

test("filters OpenRouter paid meta-routers and non-chat models while keeping free chat models", () => {
  assert.equal(isFreeModel({ id: "openrouter/free", provider: "openrouter", cost: { input: 0, output: 0 } }), true);
  assert.equal(isFreeModel({ id: "openrouter/auto", provider: "openrouter", cost: { input: 0, output: 0 } }), false);
  assert.equal(isFreeModel({ id: "openrouter/fusion", provider: "openrouter", cost: { input: 0, output: 0 } }), false);
  assert.equal(isFreeModel({ id: "typesafe/jev-router", provider: "openrouter", cost: { input: 0, output: 0 } }), false);
  assert.equal(isFreeModel({ id: "google/lyria-3-pro-preview", provider: "openrouter", cost: { input: 0, output: 0 } }), false);
  assert.equal(isFreeModel({ id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" }), true);
});

test("includes Groq chat models and excludes Groq audio/guardrail models", () => {
  assert.equal(isFreeModel({ id: "openai/gpt-oss-120b", provider: "groq", cost: { input: 0.15, output: 0.6 } }), true);
  assert.equal(isFreeModel({ id: "whisper-large-v3", provider: "groq", cost: { input: 0, output: 0 } }), false);
  assert.equal(isFreeModel({ id: "openai/gpt-oss-safeguard-20b", provider: "groq", cost: { input: 0.075, output: 0.3 } }), false);
});
