import type { MergedUsageOverview } from "@t3tools/shared/usageMerge";
import { enumerateDays } from "@t3tools/shared/usageFormat";
import type { UsageProviderKind } from "@t3tools/contracts";
import { PROVIDER_ORDER } from "./usageProviders";

export type OverviewDay = MergedUsageOverview["daily"][number];
export type CalendarMetric = "tokens" | "time";
export interface UsageCalendarCell {
  readonly day: string;
  readonly tokens: number;
  readonly activeMs: number;
  readonly records: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export function usedCostProviders(
  day: OverviewDay | undefined,
  hiddenProviders?: ReadonlySet<UsageProviderKind>,
): readonly UsageProviderKind[] {
  return PROVIDER_ORDER.filter((provider) => {
    if (hiddenProviders?.has(provider)) return false;
    const totals = day?.byProvider.get(provider);
    return (
      totals !== undefined &&
      (totals.records > 0 ||
        totals.outputTokens > 0 ||
        totals.providerReportedCostUsd > 0 ||
        totals.estimatedCostUsd > 0)
    );
  });
}

export function formatActiveTime(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes === 0) return milliseconds > 0 ? "<1m" : "0m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return [days ? `${days}d` : "", days || hours ? `${hours}h` : "", `${minutes % 60}m`]
    .filter(Boolean)
    .join(" ");
}

export function zonedUsageDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function buildUsageCalendar({
  daily,
  dailyMs,
  untilDay,
  metric,
}: {
  readonly daily: readonly OverviewDay[];
  readonly dailyMs: Readonly<Record<string, number>>;
  readonly untilDay: string;
  readonly metric: CalendarMetric;
}): readonly (UsageCalendarCell | null)[] {
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const start = new Date(end - 364 * 86_400_000).toISOString().slice(0, 10);
  const days = enumerateDays(start, untilDay);
  const byDay = new Map(daily.map((day) => [day.day as string, day]));
  const amount = (day: string) =>
    metric === "tokens" ? (byDay.get(day)?.outputTokens ?? 0) : (dailyMs[day] ?? 0);
  const max = Math.max(1, ...days.map(amount));
  const leading = new Date(`${start}T00:00:00Z`).getUTCDay();
  const cells: Array<UsageCalendarCell | null> = Array.from({ length: leading }, () => null);
  for (const day of days) {
    const value = amount(day);
    cells.push({
      day,
      tokens: byDay.get(day)?.outputTokens ?? 0,
      activeMs: dailyMs[day] ?? 0,
      records: byDay.get(day)?.records ?? 0,
      level:
        value <= 0 ? 0 : value <= max / 4 ? 1 : value <= max / 2 ? 2 : value <= max * 0.75 ? 3 : 4,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function calendarNeighbor(
  cells: readonly (UsageCalendarCell | null)[],
  day: string,
  key: string,
): string | null {
  const index = cells.findIndex((cell) => cell?.day === day);
  const offset =
    key === "ArrowRight"
      ? 7
      : key === "ArrowLeft"
        ? -7
        : key === "ArrowDown"
          ? 1
          : key === "ArrowUp"
            ? -1
            : 0;
  return index < 0 || offset === 0 ? null : (cells[index + offset]?.day ?? null);
}

export function costCaption(
  day: Pick<
    OverviewDay,
    | "providerReportedCostUsd"
    | "estimatedCostUsd"
    | "providerReportedRecords"
    | "unpricedRecords"
    | "records"
  >,
): string {
  if (day.unpricedRecords >= day.records && day.records > 0) return "Unpriced";
  const estimated = day.records > day.providerReportedRecords + day.unpricedRecords;
  const source = estimated ? (day.providerReportedRecords > 0 ? "Mixed" : "Est.") : "Reported";
  return day.unpricedRecords > 0 ? `${source} · partial` : source;
}
