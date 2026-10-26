import { expect, it } from "vite-plus/test";
import {
  activityDay,
  decodeAppActivity,
  EMPTY_APP_ACTIVITY,
  recordAppActivity,
  summarizeAppActivity,
} from "./appActivity.logic";

it("splits active time at local midnight and retains the original tracking date", () => {
  const start = new Date(2026, 9, 26, 23, 59).getTime();
  const end = new Date(2026, 9, 27, 0, 2).getTime();
  const recorded = recordAppActivity(EMPTY_APP_ACTIVITY, start, end);
  expect(recorded.days).toEqual({ [activityDay(start)]: 60_000, [activityDay(end)]: 120_000 });
  expect(summarizeAppActivity(recorded, end)).toEqual({
    todayMs: 120_000,
    totalMs: 180_000,
    sessionMs: 0,
    trackedSince: new Date(start).toISOString(),
    dailyMs: recorded.days,
  });
  expect(recordAppActivity(recorded, end, end + 60_000).trackedSince).toBe(recorded.trackedSince);
  expect(summarizeAppActivity(recorded, end, 30_000).sessionMs).toBe(30_000);
});

it("restores measured history while rejecting corrupt or impossible durations", () => {
  const restored = decodeAppActivity(
    JSON.stringify({
      version: 1,
      trackedSince: "2026-10-26T00:00:00.000Z",
      days: { "2026-10-26": 1000, "2026-10-27": -1, "2026-10-28": 1e20, bad: 1000 },
    }),
  );
  expect(restored.days).toEqual({ "2026-10-26": 1000 });
  expect(decodeAppActivity("broken")).toBe(EMPTY_APP_ACTIVITY);
  expect(decodeAppActivity('{"version":2,"days":{}}')).toBe(EMPTY_APP_ACTIVITY);
  expect(recordAppActivity(restored, 1000, 0)).toBe(restored);
});
