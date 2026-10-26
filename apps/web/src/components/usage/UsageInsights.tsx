import { CalendarDaysIcon, Clock3Icon } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";
import type { UsageProviderKind } from "@t3tools/contracts";
import type { MergedUsageOverview } from "@t3tools/shared/usageMerge";
import { formatCount, formatDayShort, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import {
  buildUsageCalendar,
  calendarNeighbor,
  costCaption,
  formatActiveTime,
  zonedUsageDay,
  usedCostProviders,
  type CalendarMetric,
  type OverviewDay,
} from "./usageInsights.logic";

export interface AppActivityTotals {
  readonly todayMs: number;
  readonly totalMs: number;
  readonly sessionMs: number;
  readonly trackedSince: string | null;
  readonly dailyMs: Readonly<Record<string, number>>;
}

const NO_COVERAGE_MESSAGES: readonly string[] = [];
const shades = [
  "bg-muted/60",
  "bg-primary/20",
  "bg-primary/40",
  "bg-primary/65",
  "bg-primary",
] as const;
const periods = [
  ["last24h", "Past 24h"],
  ["last7d", "7 days"],
  ["last30d", "30 days"],
  ["lifetime", "Lifetime"],
] as const;

const longDay = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" });
const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
function dateLabel(day: string) {
  return longDay.format(new Date(`${day}T00:00:00Z`));
}

function costTitle(totals: Omit<OverviewDay, "day" | "byProvider">) {
  return `${formatUsd(totals.providerReportedCostUsd)} provider reported · ${formatUsd(totals.estimatedCostUsd)} API estimate${totals.unpricedRecords ? ` · ${formatCount(totals.unpricedRecords)} unpriced ${totals.unpricedRecords === 1 ? "record" : "records"}` : ""}`;
}

export function UsageInsights({
  overview,
  activity,
  timeZone,
  partial = false,
  now,
  coverageMessages = NO_COVERAGE_MESSAGES,
  hiddenProviders,
}: {
  readonly overview: MergedUsageOverview | undefined;
  readonly activity: AppActivityTotals;
  readonly timeZone: string;
  readonly partial?: boolean;
  readonly now?: string;
  readonly coverageMessages?: readonly string[];
  readonly hiddenProviders?: ReadonlySet<UsageProviderKind>;
}) {
  const [mountedAt] = useState(() => new Date().toISOString());
  const [metric, setMetric] = useState<CalendarMetric>("tokens");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [previewDay, setPreviewDay] = useState<string | null>(null);
  const [showAllDays, setShowAllDays] = useState(false);
  const [showRecentDays, setShowRecentDays] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const today = now
    ? zonedUsageDay(now, timeZone)
    : [
        zonedUsageDay(mountedAt, timeZone),
        ...(overview ? [zonedUsageDay(overview.asOf, timeZone)] : []),
        ...Object.keys(activity.dailyMs),
      ]
        .toSorted()
        .at(-1)!;
  const cells = buildUsageCalendar({
    daily: overview?.daily ?? [],
    dailyMs: activity.dailyMs,
    untilDay: today,
    metric,
  });
  const weeks = cells.length / 7;
  const focusedDay = selectedDay ?? today;
  const detailDay = previewDay ?? selectedDay ?? today;
  const detail = overview?.daily.find((day) => day.day === detailDay);
  const costDay = overview?.daily.find((day) => day.day === (selectedDay ?? today));
  const recentDays = (overview?.daily.toReversed() ?? []).filter((day) => day.day !== costDay?.day);
  const dayRows = recentDays.slice(0, showAllDays ? undefined : 7);
  const calendarTotal = cells.reduce(
    (sum, cell) => sum + (metric === "tokens" ? (cell?.tokens ?? 0) : (cell?.activeMs ?? 0)),
    0,
  );
  const trackedDay = activity.trackedSince ? zonedUsageDay(activity.trackedSince, timeZone) : null;
  const appDayDescription = (day: string) =>
    trackedDay && day >= trackedDay
      ? `${formatActiveTime(activity.dailyMs[day] ?? 0)} app time`
      : "App time not tracked";
  const firstRecorded = overview?.firstRecordedAt
    ? zonedUsageDay(overview.firstRecordedAt, timeZone)
    : null;
  const partialHistory = partial || (overview?.unavailableEnvironments.length ?? 0) > 0;
  const firstCell = cells.find((cell) => cell !== null);
  const firstSunday = firstCell
    ? Date.parse(`${firstCell.day}T00:00:00Z`) -
      new Date(`${firstCell.day}T00:00:00Z`).getUTCDay() * 86_400_000
    : 0;
  const datedCells = cells.map((cell, index) => ({
    cell,
    key: new Date(firstSunday + index * 86_400_000).toISOString(),
  }));
  const calendarBlocks = Array.from({ length: 4 }, (_, block) => {
    const from = Math.floor((block * weeks) / 4) * 7;
    const until = Math.floor(((block + 1) * weeks) / 4) * 7;
    const entries = datedCells.slice(from, until);
    const first = entries.find(({ cell }) => cell !== null)?.cell;
    return {
      key: entries[0]!.key,
      entries,
      weeks: entries.length / 7,
      months: entries.flatMap(({ cell }, index) =>
        cell && ((cell === first && Number(cell.day.slice(-2)) <= 21) || cell.day.endsWith("-01"))
          ? [
              {
                label: shortMonth.format(new Date(`${cell.day}T00:00:00Z`)),
                column: Math.floor(index / 7) + 1,
              },
            ]
          : [],
      ),
    };
  });

  return (
    <section aria-label="Usage insights" className="@container/insights mb-8 space-y-5">
      <section
        aria-label="App total usage"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Clock3Icon className="size-4 text-muted-foreground" />
            App total usage
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">Lifetime (this session)</p>
        </div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatActiveTime(activity.totalMs).replaceAll(" ", "")}{" "}
          <span className="text-base font-normal text-muted-foreground">
            ({formatActiveTime(activity.sessionMs).replaceAll(" ", "")})
          </span>
        </p>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Token usage</h2>
        <span className="text-xs text-muted-foreground">
          Output only · includes reasoning{partialHistory ? " · partial history" : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 @2xl/insights:grid-cols-4">
        {periods.map(([key, label]) => (
          <div key={key} className="rounded-xl border border-border bg-card px-4 py-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
              {overview?.firstRecordedAt ? formatTokens(overview.generatedTokens[key]) : "-"}
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <p>
          {firstRecorded
            ? `Retained provider history since ${dateLabel(firstRecorded)}.`
            : overview
              ? "No retained token history yet."
              : "Provider history is not available yet."}{" "}
          Lifetime covers available records; providers may retain shorter histories.
        </p>
        <p>
          App time: this device, while visible and focused
          {activity.trackedSince
            ? ` · tracked since ${dateLabel(zonedUsageDay(activity.trackedSince, timeZone))}`
            : " · tracking starts now"}
          .
        </p>
      </div>

      {coverageMessages.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">History coverage</summary>
          <ul className="mt-2 space-y-1">
            {coverageMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <section
        className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
        aria-label="Yearly activity"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <CalendarDaysIcon className="size-4 text-muted-foreground" />
              Your year in mines
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {metric === "tokens"
                ? overview?.firstRecordedAt
                  ? `${formatTokens(calendarTotal)} generated tokens in retained records`
                  : "No retained token history"
                : `${formatActiveTime(calendarTotal)} active on this device`}{" "}
              · past 365 days
            </p>
          </div>
          <ToggleGroup
            variant="segmented"
            aria-label="Calendar metric"
            value={[metric]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "tokens" || next === "time") setMetric(next);
            }}
          >
            <Toggle value="tokens">Tokens</Toggle>
            <Toggle value="time">App time</Toggle>
          </ToggleGroup>
        </div>
        <div
          className="grid min-w-0 grid-cols-1 gap-x-2 gap-y-4 @sm/insights:grid-cols-2 @2xl/insights:grid-cols-[var(--calendar-columns)]"
          style={
            {
              "--calendar-columns": calendarBlocks.map((block) => `${block.weeks}fr`).join(" "),
            } as CSSProperties
          }
          aria-label="Activity by day"
          onPointerLeave={() => setPreviewDay(null)}
        >
          {calendarBlocks.map((block) => (
            <div key={block.key} className="min-w-0">
              <div
                className="mb-1.5 grid h-4 gap-0.5 text-3xs text-muted-foreground"
                style={{ gridTemplateColumns: `repeat(${block.weeks}, minmax(0, 1fr))` }}
              >
                {block.months.map((month) => (
                  <span
                    key={`${month.column}:${month.label}`}
                    className="min-w-0 truncate"
                    style={{
                      gridColumn: `${month.column} / span ${Math.min(3, block.weeks - month.column + 1)}`,
                    }}
                  >
                    {month.label}
                  </span>
                ))}
              </div>
              <div
                className="grid grid-flow-col grid-rows-7 gap-0.5"
                style={{ gridTemplateColumns: `repeat(${block.weeks}, minmax(0, 1fr))` }}
              >
                {block.entries.map(({ cell, key }) =>
                  cell ? (
                    <button
                      key={cell.day}
                      type="button"
                      ref={(element) => {
                        if (element) buttons.current.set(cell.day, element);
                        else buttons.current.delete(cell.day);
                      }}
                      className={cn(
                        "aspect-square w-full rounded-xs outline-none ring-inset hover:ring-1 hover:ring-foreground/60 focus-visible:ring-2 focus-visible:ring-ring",
                        shades[cell.level],
                        selectedDay === cell.day && "ring-1 ring-foreground",
                      )}
                      aria-label={`${dateLabel(cell.day)}: ${metric === "tokens" ? (cell.records ? `${formatTokens(cell.tokens)} generated tokens` : "No retained records") : appDayDescription(cell.day)}`}
                      aria-pressed={selectedDay === cell.day}
                      tabIndex={cell.day === focusedDay ? 0 : -1}
                      onPointerEnter={() => setPreviewDay(cell.day)}
                      onFocus={() => setPreviewDay(cell.day)}
                      onBlur={() => setPreviewDay(null)}
                      onClick={() => setSelectedDay(cell.day)}
                      onKeyDown={(event) => {
                        const next = calendarNeighbor(cells, cell.day, event.key);
                        if (!next) return;
                        event.preventDefault();
                        setSelectedDay(next);
                        buttons.current.get(next)?.focus();
                      }}
                    />
                  ) : (
                    <span key={key} className="aspect-square w-full" aria-hidden />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <p role="status" aria-live="polite">
            {dateLabel(detailDay)} · {appDayDescription(detailDay)}
            {detail
              ? ` · ${formatTokens(detail.outputTokens)} generated tokens · ${costTitle(detail)}`
              : " · no retained token records"}
          </p>
          <div className="flex items-center gap-1.5" aria-label="Calendar intensity: less to more">
            <span>Less</span>
            {shades.map((shade) => (
              <span key={shade} className={cn("size-2.5 rounded-sm", shade)} aria-hidden />
            ))}
            <span>More</span>
          </div>
        </div>
      </section>
      <section className="space-y-3" aria-label="Daily API costs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Daily API costs</h2>
          {selectedDay ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setSelectedDay(null);
                setPreviewDay(null);
                setShowRecentDays(true);
              }}
            >
              Show recent days
            </Button>
          ) : null}
        </div>
        <div
          className="rounded-xl border border-border bg-card p-3"
          role="region"
          aria-label="Daily API costs by provider"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              {selectedDay ? formatDayShort(selectedDay) : "Today"}
            </h3>
            {costDay ? (
              <div className="text-lg font-semibold tabular-nums">
                <CostCell totals={costDay} />
              </div>
            ) : null}
          </div>
          {costDay ? (
            <div className="mt-2">
              <ProviderCosts day={costDay} hiddenProviders={hiddenProviders} />
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {overview
                ? selectedDay
                  ? `No retained records for ${formatDayShort(selectedDay)}.`
                  : overview.daily.length
                    ? "No retained records today."
                    : "No recorded API usage yet."
                : "Waiting for provider history."}
            </p>
          )}
          {recentDays.length > 0 ? (
            <div className="mt-2">
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={showRecentDays}
                onClick={() => setShowRecentDays(!showRecentDays)}
              >
                {showRecentDays ? "Hide recent days" : "Recent days"}
              </Button>
              {showRecentDays ? (
                <>
                  <ul aria-label="Recent daily costs" className="mt-2 divide-y divide-border/50">
                    {dayRows.map((day) => (
                      <li
                        key={day.day}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <span className="text-muted-foreground">{formatDayShort(day.day)}</span>
                          <ProviderCosts day={day} hiddenProviders={hiddenProviders} />
                        </div>
                        <span className="text-xs font-medium tabular-nums">
                          <CostCell totals={day} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {recentDays.length > 7 ? (
                    <Button variant="ghost" size="xs" onClick={() => setShowAllDays(!showAllDays)}>
                      {showAllDays ? "Show fewer days" : "Show all recorded days"}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Provider reports and API estimates, not subscription invoices. Est. = token-price estimate
          · mixed = reported and estimated · unpriced usage is excluded from dollar totals.
        </p>
      </section>
    </section>
  );
}

function CostCell({
  totals,
}: {
  readonly totals: Omit<OverviewDay, "day" | "byProvider"> | undefined;
}) {
  if (!totals) return <span className="text-muted-foreground">-</span>;
  const caption = costCaption(totals);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-baseline gap-1.5" />}
        aria-label={costTitle(totals)}
      >
        <span>
          {caption === "Unpriced"
            ? "-"
            : formatUsd(totals.providerReportedCostUsd + totals.estimatedCostUsd)}
        </span>
        <span className="text-3xs font-normal text-muted-foreground">{caption}</span>
      </TooltipTrigger>
      <TooltipPopup>{costTitle(totals)}</TooltipPopup>
    </Tooltip>
  );
}

function ProviderCosts({
  day,
  hiddenProviders,
}: {
  readonly day: OverviewDay;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind> | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {usedCostProviders(day, hiddenProviders).map((provider) => (
        <span
          key={provider}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs tabular-nums"
        >
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex items-center" />}>
              <ProviderInstanceIcon
                driverKind={PROVIDER_PRESENTATION[provider].driverKind}
                displayName={PROVIDER_PRESENTATION[provider].label}
                iconClassName="size-3.5"
              />
              <span className="sr-only">{PROVIDER_PRESENTATION[provider].label}</span>
            </TooltipTrigger>
            <TooltipPopup>{PROVIDER_PRESENTATION[provider].label}</TooltipPopup>
          </Tooltip>
          <CostCell totals={day.byProvider.get(provider)} />
        </span>
      ))}
    </div>
  );
}
