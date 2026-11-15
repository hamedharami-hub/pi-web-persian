import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readModelsConfig } from "./models-config-store";

export interface GsbQuotaBucket {
  id: string;
  label: string;
  remainingPercent: number;
  usedPercent: number;
  total: number | null;
  remaining: number | null;
  resetAt: string | null;
  unlimited: boolean;
}

export interface GsbAccountQuota {
  id: string;
  email: string | null;
  status: string;
  statusReason: string | null;
  disabled: boolean;
  quarantined: boolean;
  cooldownUntil: string | null;
  models: string[];
  fiveHour: GsbQuotaBucket | null;
  weekly: GsbQuotaBucket | null;
  flash: GsbQuotaBucket | null;
  pro: GsbQuotaBucket | null;
  extraBuckets: GsbQuotaBucket[];
  quotaAt: string | null;
}

export interface GsbQuotaReport {
  providerId: string;
  capturedAt: number;
  accounts: GsbAccountQuota[];
}

export type GsbQuotaResult =
  | { providerId: string; status: "ready"; report: GsbQuotaReport }
  | { providerId: string; status: "query-failed"; message: string };

const GSB_CACHE_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;
const ACCOUNTS_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES = 1_048_576;
const GSB_NAME_PATTERN = /\bgsb\b|gemini[\s_-]*web/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoOrNull(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function isGsbProviderEntry(
  providerId: string,
  baseUrl: string | undefined,
  displayName?: string,
): { origin: string } | null {
  if (!baseUrl || !baseUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const matchesId = providerId === "gemini-web" || GSB_NAME_PATTERN.test(providerId);
  const matchesPort = parsed.port === "20133";
  const matchesName = Boolean(displayName && GSB_NAME_PATTERN.test(displayName));
  if (!matchesId && !matchesPort && !matchesName) return null;
  return { origin: parsed.origin };
}

function computePercents(
  total: number | null,
  remaining: number | null,
  usagePercentage: number | null,
  unlimited: boolean,
): { remainingPercent: number; usedPercent: number } {
  if (unlimited) return { remainingPercent: 100, usedPercent: 0 };
  if (total !== null && total > 0 && remaining !== null) {
    const remainingPercent = clamp(roundTenth((remaining / total) * 100));
    return { remainingPercent, usedPercent: clamp(roundTenth(100 - remainingPercent)) };
  }
  if (usagePercentage !== null) {
    const usedPercent = clamp(roundTenth(usagePercentage));
    return { remainingPercent: clamp(roundTenth(100 - usedPercent)), usedPercent };
  }
  return { remainingPercent: 0, usedPercent: 0 };
}

function parseBucket(raw: unknown): GsbQuotaBucket | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id);
  if (!id) return null;
  const label = nonEmptyString(raw.label) ?? id;
  const total = finiteNumber(raw.total);
  const remaining = finiteNumber(raw.remaining);
  const usagePercentage = finiteNumber(raw.usagePercentage);
  const unlimited = raw.unlimited === true;
  if (!unlimited && total === null && remaining === null && usagePercentage === null) return null;
  const { remainingPercent, usedPercent } = computePercents(total, remaining, usagePercentage, unlimited);
  return {
    id,
    label,
    remainingPercent,
    usedPercent,
    total,
    remaining,
    resetAt: isoOrNull(raw.resetAt),
    unlimited,
  };
}

export function normalizeGsbAccountsPayload(
  providerId: string,
  payload: unknown,
  capturedAt = Date.now(),
): GsbQuotaReport {
  if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
    throw new Error("GSB returned an unexpected accounts payload.");
  }
  const accounts: GsbAccountQuota[] = [];
  for (const item of payload.accounts) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item.id) ?? nonEmptyString(item.email);
    if (!id) continue;
    const models = Array.isArray(item.models)
      ? item.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];

    let fiveHour: GsbQuotaBucket | null = null;
    let weekly: GsbQuotaBucket | null = null;
    let flash: GsbQuotaBucket | null = null;
    let pro: GsbQuotaBucket | null = null;
    const extraBuckets: GsbQuotaBucket[] = [];

    if (Array.isArray(item.quota)) {
      for (const rawBucket of item.quota) {
        const bucket = parseBucket(rawBucket);
        if (!bucket) continue;
        if (bucket.id === "5h") fiveHour = bucket;
        else if (bucket.id === "weekly") weekly = bucket;
        else if (bucket.id === "11") flash = bucket;
        else if (bucket.id === "4") pro = bucket;
        else extraBuckets.push(bucket);
      }
    }

    accounts.push({
      id,
      email: nonEmptyString(item.email),
      status: nonEmptyString(item.status) ?? "unknown",
      statusReason: nonEmptyString(item.statusReason),
      disabled: item.disabled === true,
      quarantined: item.quarantined === true,
      cooldownUntil: isoOrNull(item.cooldownUntil),
      models,
      fiveHour,
      weekly,
      flash,
      pro,
      extraBuckets,
      quotaAt: isoOrNull(item.quotaAt),
    });
  }

  return { providerId, capturedAt, accounts };
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) throw new Error("GSB response was too large.");
  if (!response.ok) throw new Error(`GSB returned HTTP ${response.status}.`);
  return JSON.parse(body) as unknown;
}

const cachedByKey = new Map<string, { at: number; result: GsbQuotaResult }>();

export function clearGsbQuotaCache(): void {
  cachedByKey.clear();
}

export async function queryGsbQuota(
  providerId = "gemini-web",
  options: {
    refresh?: boolean;
    fetchImpl?: typeof globalThis.fetch;
    readConfig?: () => Record<string, unknown>;
    resolveApiKey?: (id: string) => Promise<string | undefined>;
    now?: () => number;
  } = {},
): Promise<GsbQuotaResult> {
  const readConfig = options.readConfig ?? (() => readModelsConfig());
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const refresh = options.refresh === true;

  let entry: Record<string, unknown> | undefined;
  try {
    const config = readConfig();
    const providers = isRecord(config.providers) ? config.providers : {};
    const candidate = providers[providerId];
    entry = isRecord(candidate) ? candidate : undefined;
  } catch {
    return { providerId, status: "query-failed", message: "Could not read models.json." };
  }

  const baseUrl = nonEmptyString(entry?.baseUrl) ?? undefined;
  const displayName = nonEmptyString(entry?.name) ?? undefined;
  const target = isGsbProviderEntry(providerId, baseUrl, displayName);
  if (!target) {
    return { providerId, status: "query-failed", message: "Not a configured Gemini Web (GSB) provider." };
  }

  const cacheKey = `${providerId}:${target.origin}`;
  const cached = cachedByKey.get(cacheKey);
  if (!refresh && cached && cached.result.status === "ready" && now() - cached.at < GSB_CACHE_MS) {
    return cached.result;
  }

  let apiKey: string | undefined;
  try {
    if (options.resolveApiKey) {
      apiKey = await options.resolveApiKey(providerId);
    } else {
      const runtime = await ModelRuntime.create({ refreshOnCreate: false });
      const resolved = await runtime.getAuth(providerId);
      apiKey = resolved?.auth.apiKey;
    }
  } catch {
    apiKey = undefined;
  }

  const headers: Record<string, string> = apiKey
    ? { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    : { Accept: "application/json" };

  try {
    if (refresh) {
      await fetchJson(fetchImpl, `${target.origin}/v1/quota?fresh=1`, headers, REFRESH_TIMEOUT_MS)
        .catch(() => undefined);
    }
    const payload = await fetchJson(fetchImpl, `${target.origin}/v1/accounts`, headers, ACCOUNTS_TIMEOUT_MS);
    const report = normalizeGsbAccountsPayload(providerId, payload, now());
    const result: GsbQuotaResult = { providerId, status: "ready", report };
    cachedByKey.set(cacheKey, { at: now(), result });
    return result;
  } catch (error) {
    return {
      providerId,
      status: "query-failed",
      message: error instanceof Error ? error.message : "GSB quota query failed.",
    };
  }
}
