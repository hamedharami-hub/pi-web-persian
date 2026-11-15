import type { GsbAccountQuota, GsbQuotaBucket, GsbQuotaReport } from "@/lib/gsb-quota";

const GSB_NAME_PATTERN = /\bgsb\b|gemini[\s_-]*web/i;

export function isGsbProviderMatch(providerId: string, baseUrl?: string, displayName?: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false;
  if (providerId === "gemini-web" || GSB_NAME_PATTERN.test(providerId)) return true;
  if (displayName && GSB_NAME_PATTERN.test(displayName)) return true;
  try {
    return new URL(baseUrl.trim()).port === "20133";
  } catch {
    return false;
  }
}

export function gsbAccountLabel(account: Pick<GsbAccountQuota, "id" | "email">): string {
  if (account.id.trim()) return account.id.trim();
  if (account.email?.trim()) return account.email.split("@")[0] ?? account.email;
  return "account";
}

export function formatGsbResetCountdown(resetAt: string | null, now = Date.now()): string | null {
  if (!resetAt) return null;
  const target = Date.parse(resetAt);
  if (!Number.isFinite(target)) return null;
  const diffMs = target - now;
  if (diffMs <= 0) return null;
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function summarizeGsbAccounts(accounts: readonly GsbAccountQuota[]): {
  active: number;
  total: number;
  fiveHourMin: number | null;
  weeklyMin: number | null;
} {
  const active = accounts.filter((acc) => !acc.disabled && !acc.quarantined && acc.status === "ok").length;
  const pickMin = (pick: (acc: GsbAccountQuota) => GsbQuotaBucket | null): number | null => {
    const activeVals = accounts
      .filter((acc) => !acc.disabled && !acc.quarantined && acc.status === "ok")
      .map(pick)
      .filter((b): b is GsbQuotaBucket => Boolean(b && !b.unlimited))
      .map((b) => Math.round(b.remainingPercent));
    const vals = activeVals.length > 0
      ? activeVals
      : accounts
          .map(pick)
          .filter((b): b is GsbQuotaBucket => Boolean(b && !b.unlimited))
          .map((b) => Math.round(b.remainingPercent));
    return vals.length > 0 ? Math.min(...vals) : null;
  };
  return {
    active,
    total: accounts.length,
    fiveHourMin: pickMin((acc) => acc.fiveHour),
    weeklyMin: pickMin((acc) => acc.weekly),
  };
}

export function gsbSidebarBadgeText(report: GsbQuotaReport | null | undefined): string | null {
  if (!report || report.accounts.length === 0) return null;
  const summary = summarizeGsbAccounts(report.accounts);
  if (summary.fiveHourMin !== null && summary.weeklyMin !== null) {
    return `${summary.fiveHourMin}%·${summary.weeklyMin}%`;
  }
  if (summary.fiveHourMin !== null) return `${summary.fiveHourMin}%`;
  return `${summary.active}/${summary.total}`;
}

export function gsbSidebarTooltip(report: GsbQuotaReport | null | undefined): string | undefined {
  if (!report || report.accounts.length === 0) return undefined;
  return report.accounts
    .map((acc) => {
      const f = acc.fiveHour ? (acc.fiveHour.unlimited ? "∞" : `${Math.round(acc.fiveHour.remainingPercent)}%`) : "—";
      const w = acc.weekly ? (acc.weekly.unlimited ? "∞" : `${Math.round(acc.weekly.remainingPercent)}%`) : "—";
      return `${gsbAccountLabel(acc)}: 5h ${f} · W ${w}${acc.status !== "ok" ? ` (${acc.status})` : ""}`;
    })
    .join("\n");
}
