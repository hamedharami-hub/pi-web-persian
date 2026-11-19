import { existsSync, realpathSync } from "node:fs";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const SYNC_TIMEOUT_MS = 12_000;

const GROQ_NON_CHAT_RE = /^(?:whisper|distil-whisper|playai-tts|canopylabs\/orpheus|meta-llama\/llama-(?:prompt-)?guard)|safeguard/i;
const OPENROUTER_DROP_IDS = new Set([
  "openrouter/auto",
  "openrouter/auto-beta",
  "openrouter/auto-code",
  "openrouter/fusion",
  "openrouter/pareto-code",
]);
const NON_CHAT_ID_RE = /(?:^|\/)lyria-/i;

interface StoredModelEntry {
  id: string;
  name?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  type?: string;
}

interface StoredProviderEntry {
  models?: StoredModelEntry[];
  lastModified?: number | string;
  etag?: string;
  checkedAt?: number;
  liveSyncedAt?: number;
  [key: string]: unknown;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  status?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  provider?: { api?: string };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenCodeFreeEntry(model: { id: string; cost?: { input?: number; output?: number } }): boolean {
  if (model.id.toLowerCase().endsWith("-free")) return true;
  return model.cost?.input === 0 && model.cost?.output === 0;
}

function toPiOpenCodeGoModel(row: ModelsDevModel): StoredModelEntry | null {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;
  const outputModalities = row.modalities?.output;
  if (Array.isArray(outputModalities) && outputModalities.length > 0 && !outputModalities.includes("text")) {
    return null;
  }
  const inputModalities = row.modalities?.input;
  const input: string[] = Array.isArray(inputModalities) && inputModalities.includes("image")
    ? ["text", "image"]
    : ["text"];
  const baseUrl = typeof row.provider?.api === "string" && row.provider.api.trim()
    ? row.provider.api.trim()
    : OPENCODE_GO_OPENAI_BASE_URL;
  const reasoning = Boolean(row.reasoning);
  const entry: StoredModelEntry = {
    id,
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
    api: "openai-completions",
    provider: "opencode-go",
    baseUrl,
    reasoning,
    input,
    cost: {
      input: Number(row.cost?.input ?? 0),
      output: Number(row.cost?.output ?? 0),
      cacheRead: Number(row.cost?.cache_read ?? 0),
      cacheWrite: Number(row.cost?.cache_write ?? 0),
    },
    contextWindow: typeof row.limit?.context === "number" && row.limit.context > 0 ? row.limit.context : 128_000,
    maxTokens: typeof row.limit?.output === "number" && row.limit.output > 0 ? row.limit.output : 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: true,
      maxTokensField: "max_tokens",
    },
    type: "chat",
  };
  const effortOption = row.reasoning_options?.find((opt) => opt?.type === "effort" && Array.isArray(opt.values));
  if (effortOption?.values?.length) {
    const allowed = new Set(effortOption.values);
    entry.thinkingLevelMap = {
      off: allowed.has("none") ? "none" : null,
      minimal: allowed.has("minimal") ? "minimal" : null,
      low: allowed.has("low") ? "low" : null,
      medium: allowed.has("medium") ? "medium" : null,
      high: allowed.has("high") ? "high" : null,
      xhigh: allowed.has("xhigh") ? "xhigh" : null,
      max: allowed.has("max") ? "max" : null,
    };
  }
  return entry;
}

function readStoredApiKey(authJson: Record<string, unknown>, providerId: string, envVar?: string): string | null {
  const entry = authJson[providerId];
  if (isRecord(entry)) {
    const candidate = typeof entry.key === "string" ? entry.key : typeof entry.apiKey === "string" ? entry.apiKey : "";
    if (candidate.trim()) return candidate.trim();
  }
  if (envVar) {
    const envVal = process.env[envVar]?.trim();
    if (envVal) return envVal;
  }
  return null;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writePrivateJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const target = existsSync(filePath) ? realpathSync(filePath) : filePath;
  const tmpPath = join(dirname(target), `.models-store.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(data), { mode: 0o600 });
    try {
      await chmod(tmpPath, 0o600);
    } catch {
      /* ignore chmod errors on filesystems without POSIX permissions */
    }
    await rename(tmpPath, target);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function timeoutSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export interface ReconcileLiveFreeOptions {
  agentDir: string;
  providers?: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Reconcile pi's `models-store.json` with live provider endpoints for
 * providers whose free/free-tier models move faster than pi.dev's overlay:
 * - `opencode-go`: add newly active free models & drop deprecated ones via models.dev
 * - `groq`: sync live `/models` for the configured Groq key, dropping 404/retired ids
 * - `openrouter`: strip non-chat models and paid meta-routers marked $0
 */
export async function reconcileLiveFreeCatalogs(
  options: ReconcileLiveFreeOptions,
): Promise<{ changed: boolean }> {
  if (process.env.PI_OFFLINE !== undefined) return { changed: false };

  const storePath = join(options.agentDir, "models-store.json");
  if (!existsSync(storePath)) return { changed: false };

  const store = await readJsonRecord(storePath);
  const auth = await readJsonRecord(join(options.agentDir, "auth.json"));
  const fetcher = options.fetchImpl ?? fetch;
  const wanted = options.providers ? new Set(options.providers) : null;
  const shouldSync = (providerId: string) => !wanted || wanted.has(providerId);

  let changed = false;

  // 1. OpenCode Go: keep non-free models, reconcile free models against models.dev.
  if (shouldSync("opencode-go") && (isRecord(store["opencode-go"]) || isRecord(auth["opencode-go"]))) {
    try {
      const response = await fetcher(MODELS_DEV_URL, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(options.signal),
      });
      if (response.ok) {
        const body = await response.json() as Record<string, { models?: Record<string, ModelsDevModel> }>;
        const rawModels = body?.["opencode-go"]?.models;
        if (isRecord(rawModels)) {
          const existingEntry = (isRecord(store["opencode-go"]) ? store["opencode-go"] : {}) as StoredProviderEntry;
          const existingModels = Array.isArray(existingEntry.models) ? existingEntry.models : [];
          const existingById = new Map(existingModels.map((m) => [m.id, m]));
          const liveFreeModels: StoredModelEntry[] = [];
          for (const [key, row] of Object.entries(rawModels)) {
            if (!isRecord(row)) continue;
            const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : key;
            if (row.status === "deprecated") continue;
            const cost = isRecord(row.cost) ? (row.cost as { input?: number; output?: number }) : undefined;
            if (!isOpenCodeFreeEntry({ id, cost })) continue;
            const mapped = toPiOpenCodeGoModel({ ...(row as ModelsDevModel), id });
            if (!mapped) continue;
            const prev = existingById.get(id);
            liveFreeModels.push(prev ? { ...prev, ...mapped } : mapped);
          }
          if (liveFreeModels.length > 0) {
            const paidKept = existingModels.filter((m) => !isOpenCodeFreeEntry(m));
            const nextModels = [...paidKept, ...liveFreeModels];
            const now = Date.now();
            if (JSON.stringify(existingModels) !== JSON.stringify(nextModels) || typeof existingEntry.liveSyncedAt !== "number") {
              const prevMod = typeof existingEntry.lastModified === "number" ? existingEntry.lastModified : 0;
              store["opencode-go"] = {
                ...existingEntry,
                models: nextModels,
                checkedAt: now,
                lastModified: Math.max(now, prevMod + 1),
                liveSyncedAt: now,
              };
              changed = true;
            }
          }
        }
      }
    } catch {
      /* keep existing opencode-go entries if models.dev is temporarily unreachable */
    }
  }

  // 2. Groq: sync active chat models against Groq's own `/models` endpoint.
  const groqKey = shouldSync("groq") ? readStoredApiKey(auth, "groq", "GROQ_API_KEY") : null;
  if (groqKey && isRecord(store.groq)) {
    try {
      const response = await fetcher(GROQ_MODELS_URL, {
        headers: { authorization: `Bearer ${groqKey}`, accept: "application/json" },
        signal: timeoutSignal(options.signal),
      });
      if (response.ok) {
        const body = await response.json() as { data?: Array<{ id?: unknown; active?: unknown; context_window?: unknown }> };
        if (Array.isArray(body.data)) {
          const existingEntry = store.groq as StoredProviderEntry;
          const existingModels = Array.isArray(existingEntry.models) ? existingEntry.models : [];
          const existingById = new Map(existingModels.map((m) => [m.id, m]));
          const nextModels: StoredModelEntry[] = [];
          const seen = new Set<string>();
          for (const row of body.data) {
            if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) continue;
            const id = row.id.trim();
            if (row.active === false || GROQ_NON_CHAT_RE.test(id) || seen.has(id)) continue;
            seen.add(id);
            const prev = existingById.get(id);
            const contextWindow = typeof row.context_window === "number" && row.context_window > 0
              ? Math.floor(row.context_window)
              : prev?.contextWindow ?? 131_072;
            nextModels.push(prev
              ? { ...prev, contextWindow }
              : {
                  id,
                  name: id,
                  api: "openai-completions",
                  provider: "groq",
                  baseUrl: GROQ_BASE_URL,
                  reasoning: id.startsWith("qwen/") || id.includes("gpt-oss"),
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow,
                  maxTokens: 32_768,
                  compat: { supportsStrictMode: true },
                  type: "chat",
                });
          }
          if (nextModels.length > 0 && (JSON.stringify(existingModels) !== JSON.stringify(nextModels) || typeof existingEntry.liveSyncedAt !== "number")) {
            const now = Date.now();
            const prevMod = typeof existingEntry.lastModified === "number" ? existingEntry.lastModified : 0;
            store.groq = {
              ...existingEntry,
              models: nextModels,
              checkedAt: now,
              lastModified: Math.max(now, prevMod + 1),
              liveSyncedAt: now,
            };
            changed = true;
          }
        }
      }
    } catch {
      /* keep existing groq models if Groq /models fails */
    }
  }

  // 3. OpenRouter fallback store cleanup: prune paid meta-routers and audio models.
  if (shouldSync("openrouter") && isRecord(store.openrouter)) {
    const existingEntry = store.openrouter as StoredProviderEntry;
    const existingModels = Array.isArray(existingEntry.models) ? existingEntry.models : [];
    const cleaned = existingModels.filter((m) => {
      const lower = m.id.toLowerCase();
      return !OPENROUTER_DROP_IDS.has(lower) && !NON_CHAT_ID_RE.test(m.id);
    });
    if (cleaned.length !== existingModels.length) {
      store.openrouter = { ...existingEntry, models: cleaned };
      changed = true;
    }
  }

  if (changed) {
    await writePrivateJsonAtomic(storePath, store);
  }
  return { changed };
}

function readLiveSyncedIds(store: Record<string, unknown>, providerId: string): Set<string> | null {
  const entry = store[providerId];
  if (!isRecord(entry) || typeof entry.liveSyncedAt !== "number" || !Array.isArray(entry.models) || entry.models.length === 0) {
    return null;
  }
  const ids = new Set<string>();
  for (const model of entry.models) {
    if (isRecord(model) && typeof model.id === "string" && model.id.trim()) {
      ids.add(model.id.trim());
    }
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Filter stale built-in models that `withRemoteCatalog` merges additively
 * once a provider has been live-synced into `models-store.json`.
 */
export async function filterStaleLiveModels<
  T extends { id: string; provider: string; cost?: { input?: number; output?: number } },
>(models: readonly T[], agentDir: string): Promise<T[]> {
  const storePath = join(agentDir, "models-store.json");
  if (!existsSync(storePath)) return [...models];
  const store = await readJsonRecord(storePath);
  const groqIds = readLiveSyncedIds(store, "groq");
  const openCodeIds = readLiveSyncedIds(store, "opencode-go");
  return models.filter((model) => {
    if (model.provider === "groq" && groqIds) {
      return groqIds.has(model.id);
    }
    if (model.provider === "opencode-go" && openCodeIds && isOpenCodeFreeEntry(model)) {
      return openCodeIds.has(model.id);
    }
    if (model.provider === "openrouter") {
      const lower = model.id.toLowerCase();
      if (OPENROUTER_DROP_IDS.has(lower) || NON_CHAT_ID_RE.test(model.id)) return false;
    }
    return true;
  });
}
