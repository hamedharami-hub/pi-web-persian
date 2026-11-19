import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { filterStaleLiveModels, reconcileLiveFreeCatalogs } = await jiti.import("./live-free-sync.ts");

test("adds newly active opencode-go free models, drops deprecated ones, and syncs live groq models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-live-free-"));
  const prevOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;

  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api_key", key: "oc-test" },
      groq: { type: "api_key", key: "groq-test" },
    }));
    await writeFile(join(dir, "models-store.json"), JSON.stringify({
      "opencode-go": {
        checkedAt: 1,
        models: [
          { id: "deepseek-v4.1-flash", cost: { input: 0.15, output: 0.6 } },
          { id: "beam-free", cost: { input: 0, output: 0 } },
          { id: "minimax-m3.1-flash-free", cost: { input: 0, output: 0 } },
        ],
      },
      groq: {
        checkedAt: 1,
        models: [
          { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", cost: { input: 0.05, output: 0.08 } },
          { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", cost: { input: 0.15, output: 0.6 } },
        ],
      },
      openrouter: {
        checkedAt: 1,
        models: [
          { id: "openrouter/auto", cost: { input: 0, output: 0 } },
          { id: "google/lyria-3-pro-preview", cost: { input: 0, output: 0 } },
          { id: "openrouter/free", cost: { input: 0, output: 0 } },
        ],
      },
    }));

    const result = await reconcileLiveFreeCatalogs({
      agentDir: dir,
      fetchImpl: async (url) => {
        if (String(url).includes("models.dev")) {
          return Response.json({
            "opencode-go": {
              models: {
                "beam-free": { id: "beam-free", name: "Beam Free", status: "active", cost: { input: 0, output: 0 } },
                "hy4-flash-free": { id: "hy4-flash-free", name: "Hy4 flash Free", status: "active", cost: { input: 0, output: 0 }, reasoning: true, modalities: { input: ["text", "image"], output: ["text"] } },
                "minimax-m3.1-flash-free": { id: "minimax-m3.1-flash-free", status: "deprecated", cost: { input: 0, output: 0 } },
              },
            },
          });
        }
        return Response.json({
          data: [
            { id: "openai/gpt-oss-120b", active: true, context_window: 131072 },
            { id: "allam-2-7b", active: true, context_window: 4096 },
            { id: "whisper-large-v3", active: true },
            { id: "openai/gpt-oss-safeguard-20b", active: true },
          ],
        });
      },
    });

    assert.equal(result.changed, true);
    const updated = JSON.parse(await readFile(join(dir, "models-store.json"), "utf8"));
    assert.deepEqual(updated["opencode-go"].models.map((m) => m.id), ["deepseek-v4.1-flash", "beam-free", "hy4-flash-free"]);
    assert.deepEqual(updated.groq.models.map((m) => m.id), ["openai/gpt-oss-120b", "allam-2-7b"]);
    assert.deepEqual(updated.openrouter.models.map((m) => m.id), ["openrouter/free"]);

    const pruned = await filterStaleLiveModels(
      [
        { id: "llama-3.1-8b-instant", provider: "groq" },
        { id: "openai/gpt-oss-120b", provider: "groq" },
        { id: "minimax-m3.1-flash-free", provider: "opencode-go", cost: { input: 0, output: 0 } },
        { id: "hy4-flash-free", provider: "opencode-go", cost: { input: 0, output: 0 } },
        { id: "deepseek-v4.1-flash", provider: "opencode-go", cost: { input: 0.15, output: 0.6 } },
      ],
      dir,
    );
    assert.deepEqual(pruned.map((m) => `${m.provider}/${m.id}`), [
      "groq/openai/gpt-oss-120b",
      "opencode-go/hy4-flash-free",
      "opencode-go/deepseek-v4.1-flash",
    ]);
  } finally {
    if (prevOffline !== undefined) process.env.PI_OFFLINE = prevOffline;
    await rm(dir, { recursive: true, force: true });
  }
});
