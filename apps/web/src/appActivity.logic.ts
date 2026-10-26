export interface AppActivityLedger {
  readonly version: 1;
  readonly trackedSince: string | null;
  readonly days: Readonly<Record<string, number>>;
}

export const EMPTY_APP_ACTIVITY: AppActivityLedger = {
  version: 1,
  trackedSince: null,
  days: {},
};

export function activityDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function decodeAppActivity(raw: string | null): AppActivityLedger {
  if (!raw) return EMPTY_APP_ACTIVITY;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("days" in value) ||
      typeof value.days !== "object" ||
      value.days === null ||
      Array.isArray(value.days)
    )
      return EMPTY_APP_ACTIVITY;
    const days: Record<string, number> = {};
    for (const [day, ms] of Object.entries(value.days)) {
      if (
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        typeof ms === "number" &&
        Number.isFinite(ms) &&
        ms >= 0 &&
        ms <= 90_000_000
      )
        days[day] = ms;
    }
    return {
      version: 1,
      trackedSince:
        "trackedSince" in value &&
        typeof value.trackedSince === "string" &&
        Number.isFinite(Date.parse(value.trackedSince))
          ? value.trackedSince
          : null,
      days,
    };
  } catch {
    return EMPTY_APP_ACTIVITY;
  }
}

export function recordAppActivity(
  ledger: AppActivityLedger,
  start: number,
  end: number,
): AppActivityLedger {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return ledger;
  const days = { ...ledger.days };
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const until = Math.min(end, midnight);
    const day = activityDay(cursor);
    days[day] = (days[day] ?? 0) + until - cursor;
    cursor = until;
  }
  return { version: 1, trackedSince: ledger.trackedSince ?? new Date(start).toISOString(), days };
}

export function summarizeAppActivity(ledger: AppActivityLedger, at: number, sessionMs = 0) {
  return {
    todayMs: ledger.days[activityDay(at)] ?? 0,
    totalMs: Object.values(ledger.days).reduce((total, ms) => total + ms, 0),
    sessionMs,
    trackedSince: ledger.trackedSince,
    dailyMs: ledger.days,
  };
}
