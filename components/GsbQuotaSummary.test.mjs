import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  formatGsbResetCountdown,
  gsbAccountLabel,
  gsbSidebarBadgeText,
  gsbSidebarTooltip,
  isGsbProviderMatch,
  summarizeGsbAccounts,
} = await jiti.import("./gsb-quota-helpers.ts");

const NOW = Date.parse("2026-11-15T07:35:00Z");

const SAMPLE_REPORT = {
  providerId: "gemini-web",
  capturedAt: NOW,
  accounts: [
    {
      id: "hamed",
      email: "hamed.haramipour@gmail.com",
      status: "ok",
      statusReason: null,
      disabled: false,
      quarantined: false,
      cooldownUntil: null,
      models: ["gemini-4-hydrogen"],
      fiveHour: { id: "5h", label: "5h Window", remainingPercent: 87, usedPercent: 13, total: 2400, remaining: 2088, resetAt: "2026-11-15T07:50:00Z", unlimited: false },
      weekly: { id: "weekly", label: "Weekly Pool", remainingPercent: 82.3, usedPercent: 17.7, total: 48384, remaining: 39816, resetAt: "2026-11-16T04:35:00Z", unlimited: false },
      flash: null,
      pro: null,
      extraBuckets: [],
      quotaAt: null,
    },
    {
      id: "hamedharamipour1",
      email: "hamedharamipour1@gmail.com",
      status: "ok",
      statusReason: null,
      disabled: false,
      quarantined: false,
      cooldownUntil: null,
      models: ["gemini-4-hydrogen"],
      fiveHour: { id: "5h", label: "5h Window", remainingPercent: 100, usedPercent: 0, total: 2400, remaining: 2400, resetAt: null, unlimited: false },
      weekly: { id: "weekly", label: "Weekly Pool", remainingPercent: 100, usedPercent: 0, total: 48384, remaining: 48384, resetAt: null, unlimited: false },
      flash: null,
      pro: null,
      extraBuckets: [],
      quotaAt: null,
    },
  ],
};

test("matches GSB providers without matching regular OpenAI/Anthropic entries", () => {
  assert.equal(isGsbProviderMatch("gemini-web", "http://127.0.0.1:20133/v1"), true);
  assert.equal(isGsbProviderMatch("custom", "http://localhost:20133/v1"), true);
  assert.equal(isGsbProviderMatch("openrouter", "https://openrouter.ai/api/v1"), false);
  assert.equal(isGsbProviderMatch("gemini-web", undefined), false);
});

test("formats compact GSB countdowns, labels, and sidebar badge", () => {
  assert.equal(gsbAccountLabel({ id: "hamed", email: "hamed@gmail.com" }), "hamed");
  assert.equal(formatGsbResetCountdown("2026-11-15T07:50:00Z", NOW), "15m");
  assert.equal(formatGsbResetCountdown("2026-11-15T10:05:00Z", NOW), "2h 30m");
  assert.equal(formatGsbResetCountdown("2026-11-16T08:35:00Z", NOW), "1d 1h");
  assert.deepEqual(summarizeGsbAccounts(SAMPLE_REPORT.accounts), {
    active: 2,
    total: 2,
    fiveHourMin: 87,
    weeklyMin: 82,
  });
  assert.equal(gsbSidebarBadgeText(SAMPLE_REPORT), "87%·82%");
  assert.match(gsbSidebarTooltip(SAMPLE_REPORT), /hamed: 5h 87% · W 82%/);
});
