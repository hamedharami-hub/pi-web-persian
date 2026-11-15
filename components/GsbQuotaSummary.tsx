"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatUpdatedTime } from "@/lib/i18n/format";
import type { GsbAccountQuota, GsbQuotaBucket, GsbQuotaReport, GsbQuotaResult } from "@/lib/gsb-quota";
import { formatGsbResetCountdown, gsbAccountLabel, summarizeGsbAccounts } from "./gsb-quota-helpers";

export interface GsbQuotaController {
  report: GsbQuotaReport | null;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
}

export function useGsbQuota(providerId: string | null): GsbQuotaController {
  const { t } = useI18n();
  const [report, setReport] = useState<GsbQuotaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!providerId) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/gsb-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, refresh: force }),
      });
      const result = await response.json() as GsbQuotaResult;
      if (reqId !== reqIdRef.current) return;
      if (result.status === "ready") {
        setReport(result.report);
      } else {
        setError(result.message || t("providerUsage.queryFailed"));
      }
    } catch (caught) {
      if (reqId !== reqIdRef.current) return;
      setError(caught instanceof Error ? caught.message : t("providerUsage.queryFailed"));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [providerId, t]);

  useEffect(() => {
    reqIdRef.current += 1;
    setReport(null);
    setError(null);
    setLoading(false);
    if (providerId) void load(false);
  }, [load, providerId]);

  return { report, loading, error, refresh: load };
}

function healthColor(account: GsbAccountQuota): string {
  if (account.disabled || account.quarantined || account.status === "exhausted" || account.status === "expired") {
    return "#ef4444";
  }
  if (account.status === "cooling" || account.status === "degraded") return "#f59e0b";
  const five = account.fiveHour?.remainingPercent;
  const week = account.weekly?.remainingPercent;
  if ((five !== undefined && five <= 0) || (week !== undefined && week <= 0)) return "#ef4444";
  if ((five !== undefined && five < 15) || (week !== undefined && week < 15)) return "#f59e0b";
  return "#4ade80";
}

function barColor(pct: number): string {
  if (pct < 15) return "#ef4444";
  if (pct < 40) return "#f59e0b";
  return "#4ade80";
}

function MiniMeter({ bucket }: { bucket: GsbQuotaBucket }) {
  const pct = bucket.unlimited ? 100 : Math.min(100, Math.max(0, bucket.remainingPercent));
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 28,
        height: 4,
        borderRadius: 999,
        overflow: "hidden",
        background: "var(--border)",
        flexShrink: 0,
      }}
    >
      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: barColor(pct), borderRadius: 999 }} />
    </span>
  );
}

function formatPct(bucket: GsbQuotaBucket | null): string {
  if (!bucket) return "—";
  if (bucket.unlimited) return "∞";
  return `${Math.round(bucket.remainingPercent)}%`;
}

function formatFraction(bucket: GsbQuotaBucket | null): string | null {
  if (!bucket || bucket.unlimited || bucket.remaining === null || bucket.total === null || bucket.total <= 0) return null;
  return `${bucket.remaining.toLocaleString()} / ${bucket.total.toLocaleString()}`;
}

export function GsbQuotaSummary({ controller }: { controller: GsbQuotaController }) {
  const { locale, t } = useI18n();
  const { report, loading, error, refresh } = controller;
  const summary = report ? summarizeGsbAccounts(report.accounts) : null;
  const now = Date.now();

  return (
    <div
      style={{
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("gsbQuota.title")}</span>
          {summary && summary.total > 0 && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {t("gsbQuota.activeSummary", { ok: summary.active, total: summary.total })}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {report && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("providerUsage.updated", { time: formatUpdatedTime(report.capturedAt, locale) })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={loading}
            aria-label={t(loading ? "gsbQuota.refreshing" : "gsbQuota.refresh")}
            title={t(loading ? "gsbQuota.refreshing" : "gsbQuota.refresh")}
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--border)",
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: loading ? "wait" : "pointer",
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={loading ? { animation: "spin 0.8s linear infinite" } : undefined}
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: "#ef4444" }}>{error}</div>
      )}

      {!report && !error && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {loading ? t("i18n.loading") : t("providerUsage.notQueried")}
        </div>
      )}

      {report && report.accounts.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("gsbQuota.emptyAccounts")}</div>
      )}

      {report && report.accounts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {report.accounts.map((acc, index) => {
            const label = gsbAccountLabel(acc);
            const dot = healthColor(acc);
            const detailBuckets: Array<{ name: string; bucket: GsbQuotaBucket }> = [];
            if (acc.fiveHour) detailBuckets.push({ name: t("gsbQuota.fiveHourFull"), bucket: acc.fiveHour });
            if (acc.weekly) detailBuckets.push({ name: t("gsbQuota.weeklyFull"), bucket: acc.weekly });
            if (acc.flash) detailBuckets.push({ name: t("gsbQuota.flash"), bucket: acc.flash });
            if (acc.pro) detailBuckets.push({ name: t("gsbQuota.pro"), bucket: acc.pro });
            for (const extra of acc.extraBuckets) detailBuckets.push({ name: extra.label, bucket: extra });

            return (
              <details
                key={acc.id}
                style={{
                  borderTop: index === 0 ? "none" : "1px solid var(--border)",
                  padding: "3px 0",
                }}
              >
                <summary
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "2px 4px",
                    cursor: "pointer",
                    listStyle: "none",
                    fontSize: 11,
                  }}
                >
                  <span dir="ltr" style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: dot, flexShrink: 0 }} />
                    <span
                      title={acc.email ?? acc.id}
                      style={{
                        color: "var(--text)",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </span>
                    {(acc.status !== "ok" || acc.disabled || acc.quarantined) && (
                      <span style={{ fontSize: 10, color: dot }}>{acc.status}</span>
                    )}
                  </span>

                  <span
                    dir="ltr"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      flexShrink: 0,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--text-muted)",
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span>5h {formatPct(acc.fiveHour)}</span>
                      {acc.fiveHour && <MiniMeter bucket={acc.fiveHour} />}
                    </span>
                    <span style={{ color: "var(--text-dim)" }}>·</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span>W {formatPct(acc.weekly)}</span>
                      {acc.weekly && <MiniMeter bucket={acc.weekly} />}
                    </span>
                  </span>
                </summary>

                <div
                  style={{
                    marginTop: 4,
                    padding: "6px 8px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span dir="ltr" style={{ color: "var(--text)" }}>{acc.email ?? acc.id}</span>
                    <span style={{ color: dot }}>
                      {acc.status === "ok" ? t("gsbQuota.statusOk") : acc.status}
                      {acc.statusReason ? ` · ${acc.statusReason}` : ""}
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 4 }}>
                    {detailBuckets.map(({ name, bucket }) => {
                      const frac = formatFraction(bucket);
                      const reset = formatGsbResetCountdown(bucket.resetAt, now);
                      return (
                        <div
                          key={bucket.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 6,
                            padding: "3px 6px",
                            borderRadius: 4,
                            background: "var(--bg-panel)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                          }}
                        >
                          <span style={{ color: "var(--text-muted)" }}>{name}</span>
                          <span dir="ltr" style={{ color: "var(--text)" }}>
                            {bucket.unlimited
                              ? t("gsbQuota.unlimited")
                              : t("gsbQuota.left", { percent: Math.round(bucket.remainingPercent) })}
                            {frac ? ` (${frac})` : ""}
                            {reset ? ` · ${t("gsbQuota.resetsIn", { when: reset })}` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {acc.models.length > 0 && (
                    <div dir="ltr" style={{ fontSize: 10, color: "var(--text-dim)" }}>
                      {t("gsbQuota.models")}: {acc.models.join(", ")}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
