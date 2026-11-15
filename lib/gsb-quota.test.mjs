import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./gsb-quota.ts");
}

const {
  clearGsbQuotaCache,
  isGsbProviderEntry,
  normalizeGsbAccountsPayload,
  queryGsbQuota,
} = await loadSubject();

test("recognizes GSB providers by id, port 20133, or GSB display name", () => {
  assert.deepEqual(isGsbProviderEntry("gemini-web", "http://127.0.0.1:20133/v1"), { origin: "http://127.0.0.1:20133" });
  assert.deepEqual(isGsbProviderEntry("custom", "http://127.0.0.1:20133/v1"), { origin: "http://127.0.0.1:20133" });
  assert.deepEqual(isGsbProviderEntry("custom", "http://127.0.0.1:9999/v1", "GSB Bridge"), { origin: "http://127.0.0.1:9999" });
  assert.equal(isGsbProviderEntry("openai", "https://api.openai.com/v1"), null);
  assert.equal(isGsbProviderEntry("gemini-web", "http://user:pass@127.0.0.1:20133/v1"), null);
});

test("normalizes 5h, weekly, Flash, Pro, and sub:* cooldown buckets", () => {
  const report = normalizeGsbAccountsPayload("gemini-web", {
    accounts: [{
      id: "hamed",
      email: "hamed.haramipour@gmail.com",
      status: "ok",
      models: ["gemini-4-hydrogen", "gemini-4-carbon"],
      quota: [
        { id: "5h", label: "5h Window", usagePercentage: 13, total: 2400, remaining: 2088, resetAt: "2026-11-15T07:49:01Z", unlimited: false },
        { id: "weekly", label: "Weekly Pool", usagePercentage: 18, total: 48384, remaining: 39816, resetAt: "2026-11-16T04:49:01Z", unlimited: false },
        { id: "11", label: "Gemini Flash", usagePercentage: 17, total: 48384, remaining: 39816 },
        { id: "4", label: "Gemini Pro", usagePercentage: 17, total: 48384, remaining: 39816 },
        { id: "sub:flash", label: "Flash cooldown", usagePercentage: 100, total: 1, remaining: 0 },
      ],
    }],
  }, 123);

  assert.equal(report.capturedAt, 123);
  assert.equal(report.accounts[0].fiveHour.remainingPercent, 87);
  assert.equal(report.accounts[0].weekly.remainingPercent, 82.3);
  assert.equal(report.accounts[0].flash.id, "11");
  assert.equal(report.accounts[0].pro.id, "4");
  assert.equal(report.accounts[0].extraBuckets[0].id, "sub:flash");
});

test("queries GSB /v1/accounts, respects 30s cache, and hits /v1/quota?fresh=1 on refresh", async () => {
  clearGsbQuotaCache();
  const calls = [];
  let clock = 1_700_000_000_000;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/v1/quota?fresh=1")) {
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      accounts: [{
        id: "hamed",
        email: "hamed.haramipour@gmail.com",
        status: "ok",
        quota: [{ id: "5h", label: "5h Window", usagePercentage: 5, total: 2400, remaining: 2280 }],
      }],
    }), { status: 200 });
  };
  const readConfig = () => ({
    providers: {
      "gemini-web": { name: "GSB · Gemini Web", baseUrl: "http://127.0.0.1:20133/v1" },
    },
  });

  const first = await queryGsbQuota("gemini-web", {
    refresh: false,
    fetchImpl,
    readConfig,
    resolveApiKey: async () => "local-token",
    now: () => clock,
  });
  assert.equal(first.status, "ready");
  assert.equal(first.report.accounts[0].fiveHour.remainingPercent, 95);
  assert.deepEqual(calls, ["http://127.0.0.1:20133/v1/accounts"]);

  clock += 5_000;
  await queryGsbQuota("gemini-web", {
    refresh: false,
    fetchImpl,
    readConfig,
    resolveApiKey: async () => "local-token",
    now: () => clock,
  });
  assert.equal(calls.length, 1);

  await queryGsbQuota("gemini-web", {
    refresh: true,
    fetchImpl,
    readConfig,
    resolveApiKey: async () => "local-token",
    now: () => clock,
  });
  assert.deepEqual(calls, [
    "http://127.0.0.1:20133/v1/accounts",
    "http://127.0.0.1:20133/v1/quota?fresh=1",
    "http://127.0.0.1:20133/v1/accounts",
  ]);
  clearGsbQuotaCache();
});
