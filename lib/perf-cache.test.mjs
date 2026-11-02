import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Node's native TS loader does not resolve extensionless TS imports; jiti uses
// the same module resolution as the app and the other lib tests.
const {
  canSkipSearchJsonLine,
  getCachedSessionStats,
  getCachedSessionTree,
  getCachedTranscriptNotices,
  getDirectSessionSettings,
  getEntriesByIdMap,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./perf-cache.ts");

test("getEntriesByIdMap reuses map and updates incrementally on append", () => {
  const entries = [
    { type: "model_change", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z", provider: "anthropic", modelId: "claude-4" },
    { type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01Z", thinkingLevel: "high" },
  ];
  const map1 = getEntriesByIdMap(entries);
  const map2 = getEntriesByIdMap(entries);
  assert.equal(map1, map2, "reuses the same Map reference when unchanged");
  assert.equal(map1.get("e2")?.thinkingLevel, "high");

  entries.push({ type: "thinking_level_change", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:02Z", thinkingLevel: "low" });
  const map3 = getEntriesByIdMap(entries);
  assert.equal(map3.get("e3")?.thinkingLevel, "low");
});

test("getDirectSessionSettings resolves branch settings without copying the full branch", () => {
  const entries = [
    { type: "model_change", id: "root", parentId: null, timestamp: "2026-01-01T00:00:00Z", provider: "provider", modelId: "root-model" },
    { type: "thinking_level_change", id: "root-level", parentId: "root", timestamp: "2026-01-01T00:00:01Z", thinkingLevel: "low" },
    { type: "model_change", id: "other", parentId: "root-level", timestamp: "2026-01-01T00:00:02Z", provider: "other-provider", modelId: "other-model" },
    { type: "thinking_level_change", id: "other-level", parentId: "other", timestamp: "2026-01-01T00:00:03Z", thinkingLevel: "high" },
  ];

  assert.deepEqual(getDirectSessionSettings(entries, "other-level"), {
    thinkingLevel: "high",
    model: { provider: "other-provider", modelId: "other-model" },
  });
  assert.deepEqual(getDirectSessionSettings(entries, "root-level"), {
    thinkingLevel: "low",
    model: { provider: "provider", modelId: "root-model" },
  });
  assert.deepEqual(getDirectSessionSettings(entries, null), {
    thinkingLevel: "off",
    model: null,
  });
});

test("getCachedSessionStats caches stats on manager until entries change", () => {
  const manager = {};
  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      },
    },
  ];
  const stats1 = getCachedSessionStats(manager, entries);
  const stats2 = getCachedSessionStats(manager, entries);
  assert.equal(stats1, stats2, "returns cached stats object");
  assert.equal(stats1.tokens.total, 150);
  assert.equal(stats1.toolCalls, 1);

  entries.push({
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-01-01T00:00:01Z",
    message: {
      role: "user",
      content: "hello",
    },
  });
  const stats3 = getCachedSessionStats(manager, entries);
  assert.notEqual(stats3, stats1);
  assert.equal(stats3.userMessages, 1);
});

test("getCachedSessionTree and getCachedTranscriptNotices reuse computed structures until entries change", () => {
  const manager = {};
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: "world" } },
  ];
  let treeCalls = 0;
  const rawTree = () => {
    treeCalls++;
    return [{ entry: entries[0], children: [{ entry: entries[1], children: [] }] }];
  };

  const full1 = getCachedSessionTree(manager, entries, false, rawTree);
  const full2 = getCachedSessionTree(manager, entries, false, rawTree);
  const sum1 = getCachedSessionTree(manager, entries, true, rawTree);
  const sum2 = getCachedSessionTree(manager, entries, true, rawTree);
  assert.equal(full1, full2);
  assert.equal(sum1, sum2);
  assert.equal(treeCalls, 1, "getRawTree is called only once across projected and summary reads");

  let noticeCalls = 0;
  const computeNotices = () => {
    noticeCalls++;
    return new Map([["a1", [{ kind: "cache_warm", cost: 0.01 }]]]);
  };
  const n1 = getCachedTranscriptNotices(entries, "a1", false, computeNotices);
  const n2 = getCachedTranscriptNotices(entries, "a1", false, computeNotices);
  assert.equal(n1, n2);
  assert.equal(noticeCalls, 1);
});

test("canSkipSearchJsonLine skips non-message lines and non-matching plain lines", () => {
  const matcher = /needle/i;
  assert.equal(canSkipSearchJsonLine('{"type":"compaction","summary":"needle"}', "needle", matcher), true);
  assert.equal(canSkipSearchJsonLine('{"type":"message","message":{"role":"user","content":"unrelated"}}', "needle", matcher), true);
  assert.equal(canSkipSearchJsonLine('{"type":"message","message":{"role":"user","content":"has NEEDLE here"}}', "needle", matcher), false);
  // Lines with unicode escapes are never skipped prematurely.
  assert.equal(canSkipSearchJsonLine('{"type":"message","message":{"role":"user","content":"\\u006eedle"}}', "needle", matcher), false);
});
