import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelExhaustionError,
  MODEL_FALLBACK_INSTRUCTION,
  modelFallbackNote,
  shouldFallbackToParentModel,
} from "./subagent-model-fallback.ts";

test("provider exhaustion errors are recognised", () => {
  for (const message of [
    "This model's maximum context length is 200000 tokens",
    "context_length_exceeded",
    "insufficient_quota: you have run out of credits",
    "Quota exceeded for this billing period",
    "402 Payment Required: credit balance is too low",
    "token limit reached",
  ]) {
    assert.equal(isModelExhaustionError(message), true, message);
  }
});

test("transient and unrelated failures do not trigger a model switch", () => {
  for (const message of [
    undefined,
    null,
    "",
    "429 rate limit exceeded, retry later",
    "fetch failed",
    "The tool returned an unexpected value",
    "401 invalid api key",
  ]) {
    assert.equal(isModelExhaustionError(message), false, String(message));
  }
});

test("the switch needs a different parent model", () => {
  assert.equal(shouldFallbackToParentModel({
    error: "context_length_exceeded",
    childModel: { provider: "openrouter", id: "a/one" },
    parentModel: { provider: "openrouter", id: "openai/gpt-6.1-terra" },
  }), true);
  // Same model: retrying it fails again.
  assert.equal(shouldFallbackToParentModel({
    error: "context_length_exceeded",
    childModel: { provider: "openrouter", id: "openai/gpt-6.1-terra" },
    parentModel: { provider: "openrouter", id: "openai/gpt-6.1-terra" },
  }), false);
  // Not an exhaustion error.
  assert.equal(shouldFallbackToParentModel({
    error: "fetch failed",
    childModel: { provider: "a", id: "x" },
    parentModel: { provider: "b", id: "y" },
  }), false);
  // No parent model resolved.
  assert.equal(shouldFallbackToParentModel({
    error: "context_length_exceeded",
    childModel: { provider: "a", id: "x" },
    parentModel: undefined,
  }), false);
});

test("the continuation instruction resumes rather than restarts, and the note names the switch", () => {
  assert.match(MODEL_FALLBACK_INSTRUCTION, /continue the same task/i);
  assert.match(MODEL_FALLBACK_INSTRUCTION, /do not restart/i);
  assert.equal(
    modelFallbackNote("openrouter/a/b", { provider: "antigravity-acp-1", id: "claude-opus-5-5" }),
    "Completed on the parent session's model (antigravity-acp-1/claude-opus-5-5) after openrouter/a/b ran out of tokens.",
  );
});
