import { describe, expect, it } from "vite-plus/test";
import { UsageDay } from "@t3tools/contracts";
import {
  buildUsageCalendar,
  calendarNeighbor,
  costCaption,
  formatActiveTime,
  usedCostProviders,
  zonedUsageDay,
  type OverviewDay,
} from "./usageInsights.logic";

const day = (date: string, outputTokens: number): OverviewDay => ({
  day: UsageDay.make(date),
  outputTokens,
  records: 1,
  providerReportedCostUsd: 0,
  estimatedCostUsd: 1,
  providerReportedRecords: 0,
  unpricedRecords: 0,
  byProvider: new Map(),
});

describe("usage insights", () => {
  it("keeps only providers with retained usage, including unpriced records", () => {
    const empty = { ...day("2026-10-26", 0), records: 0, estimatedCostUsd: 0 };
    const used = {
      ...empty,
      byProvider: new Map([
        ["codex" as const, empty],
        ["claude" as const, { ...empty, records: 1, unpricedRecords: 1 }],
        ["opencode" as const, { ...empty, estimatedCostUsd: 1 }],
      ]),
    };
    expect(usedCostProviders(used)).toEqual(["claude", "opencode"]);
    expect(usedCostProviders(used, new Set(["claude"]))).toEqual(["opencode"]);
    expect(usedCostProviders(undefined)).toEqual([]);
  });
  it("formats measured app time without rounding up minutes or inventing earlier time", () => {
    expect(formatActiveTime(0)).toBe("0m");
    expect(formatActiveTime(59_999)).toBe("<1m");
    expect(formatActiveTime((6 * 60 + 32) * 60_000)).toBe("6h 32m");
    expect(formatActiveTime((24 * 1440 + 17 * 60 + 36) * 60_000)).toBe("24d 17h 36m");
  });
  it("uses viewer calendar dates across timezone and leap-day boundaries", () => {
    expect(zonedUsageDay("2026-10-25T18:00:00Z", "Asia/Shanghai")).toBe("2026-10-26");
    const cells = buildUsageCalendar({
      daily: [day("2024-02-29", 12)],
      dailyMs: {},
      untilDay: "2024-03-01",
      metric: "tokens",
    });
    const days = cells.filter((cell) => cell !== null);
    expect(days).toHaveLength(365);
    expect(days.at(-1)?.day).toBe("2024-03-01");
    expect(days.some((cell) => cell.day === "2024-02-29" && cell.tokens === 12)).toBe(true);
    expect(cells.length % 7).toBe(0);
  });
  it("keeps app time and generated tokens independent and supports keyboard day navigation", () => {
    const input = {
      daily: [day("2026-10-25", 100)],
      dailyMs: { "2026-10-26": 60_000 },
      untilDay: "2026-10-26",
    };
    const tokens = buildUsageCalendar({ ...input, metric: "tokens" });
    const activity = buildUsageCalendar({ ...input, metric: "time" });
    expect(tokens.find((cell) => cell?.day === "2026-10-26")?.level).toBe(0);
    expect(activity.find((cell) => cell?.day === "2026-10-26")?.level).toBe(4);
    expect(calendarNeighbor(tokens, "2026-10-25", "ArrowDown")).toBe("2026-10-26");
    expect(calendarNeighbor(tokens, "2026-10-26", "ArrowRight")).toBeNull();
  });
  it("keeps unknown cost distinct from a zero-cost report and identifies estimates", () => {
    expect(costCaption({ ...day("2026-10-26", 1), unpricedRecords: 1 })).toBe("Unpriced");
    expect(
      costCaption({ ...day("2026-10-26", 1), estimatedCostUsd: 0, providerReportedRecords: 1 }),
    ).toBe("Reported");
    expect(costCaption(day("2026-10-26", 1))).toBe("Est.");
  });
});
