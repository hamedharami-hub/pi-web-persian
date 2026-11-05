import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelFavorite,
  MAX_MODEL_FAVORITES,
  modelFavoriteKey,
  parseModelFavorites,
  serializeModelFavorites,
  toggleModelFavorite,
} from "./model-favorites.ts";

test("parses stored favorites and drops malformed entries", () => {
  assert.deepEqual(parseModelFavorites(null), []);
  assert.deepEqual(parseModelFavorites("not json"), []);
  assert.deepEqual(parseModelFavorites('{"a":1}'), []);
  assert.deepEqual(
    parseModelFavorites('["openrouter/openai/gpt-6.1-terra","bad","openrouter/openai/gpt-6.1-terra",7," google/gemini-4-argon "]'),
    ["openrouter/openai/gpt-6.1-terra", "google/gemini-4-argon"],
  );
});

test("several models can be starred at once and unstarring keeps the rest", () => {
  let favorites = [];
  favorites = toggleModelFavorite(favorites, "openrouter", "openai/gpt-6.1-terra");
  favorites = toggleModelFavorite(favorites, "antigravity-acp-1", "claude-opus-5-5");
  favorites = toggleModelFavorite(favorites, "inception", "mercury-3");
  assert.deepEqual(favorites, [
    "openrouter/openai/gpt-6.1-terra",
    "antigravity-acp-1/claude-opus-5-5",
    "inception/mercury-3",
  ]);
  assert.equal(isModelFavorite(favorites, "antigravity-acp-1", "claude-opus-5-5"), true);
  favorites = toggleModelFavorite(favorites, "antigravity-acp-1", "claude-opus-5-5");
  assert.deepEqual(favorites, ["openrouter/openai/gpt-6.1-terra", "inception/mercury-3"]);
  assert.equal(isModelFavorite(favorites, "antigravity-acp-1", "claude-opus-5-5"), false);
});

test("favorites round-trip through storage and stay bounded", () => {
  const favorites = ["a/one", "b/two"];
  assert.deepEqual(parseModelFavorites(serializeModelFavorites(favorites)), favorites);
  const many = Array.from({ length: MAX_MODEL_FAVORITES + 5 }, (_, index) => [`p${index}`, `m${index}`]);
  let list = [];
  for (const [provider, modelId] of many) list = toggleModelFavorite(list, provider, modelId);
  assert.equal(list.length, MAX_MODEL_FAVORITES);
  assert.deepEqual(parseModelFavorites(serializeModelFavorites(many.map(([p, m]) => modelFavoriteKey(p, m)))).length, MAX_MODEL_FAVORITES);
});
