import { UsageDay } from "@t3tools/contracts";
import type { MergedUsageOverview } from "@t3tools/shared/usageMerge";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { UsageInsights, type AppActivityTotals } from "./UsageInsights";

const reported = {
  outputTokens: 100,
  records: 1,
  providerReportedCostUsd: 2,
  estimatedCostUsd: 0,
  providerReportedRecords: 1,
  unpricedRecords: 0,
};
const estimated = {
  outputTokens: 200,
  records: 2,
  providerReportedCostUsd: 0,
  estimatedCostUsd: 3,
  providerReportedRecords: 0,
  unpricedRecords: 1,
};
const overview: MergedUsageOverview = {
  asOf: "2026-10-26T12:00:00Z",
  firstRecordedAt: "2026-10-25T10:00:00Z",
  generatedTokens: { last24h: 200, last7d: 300, last30d: 300, lifetime: 400 },
  daily: [
    { day: UsageDay.make("2026-10-25"), ...reported, byProvider: new Map([["codex", reported]]) },
    {
      day: UsageDay.make("2026-10-26"),
      ...estimated,
      byProvider: new Map([["claude", estimated]]),
    },
  ],
  providers: [],
  unavailableEnvironments: [],
};
const activity: AppActivityTotals = {
  todayMs: (6 * 60 + 32) * 60_000,
  totalMs: (6 * 60 + 32) * 60_000,
  sessionMs: (60 + 5) * 60_000,
  trackedSince: "2026-10-26T00:00:00Z",
  dailyMs: { "2026-10-26": (6 * 60 + 32) * 60_000 },
};
const now = "2026-10-26T12:00:00Z";

it("shows daily costs only for providers with retained usage", async () => {
  await using screen = await render(
    <UsageInsights overview={overview} activity={activity} timeZone="UTC" now={now} />,
  );
  const costs = screen.getByRole("region", { name: "Daily API costs by provider" });
  await screen.getByRole("button", { name: "Recent days", exact: true }).click();
  await expect.element(costs.getByText("Codex", { exact: true })).toBeInTheDocument();
  await expect.element(costs.getByText("Claude Code", { exact: true })).toBeInTheDocument();
  await expect.element(costs.getByText("OpenCode", { exact: true })).not.toBeInTheDocument();
});

it("previews real day totals and lets calendar selection and keyboard navigation filter daily provider costs", async () => {
  await using screen = await render(
    <UsageInsights overview={overview} activity={activity} timeZone="UTC" now={now} />,
  );
  const earlier = screen.getByRole("button", { name: "October 25, 2026: 100 generated tokens" });
  const today = screen.getByRole("button", { name: "October 26, 2026: 200 generated tokens" });
  await userEvent.hover(earlier);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "October 25, 2026 · App time not tracked · 100 generated tokens · $2.00 provider reported · $0.00 API estimate",
    );
  await today.click();
  await expect.element(screen.getByRole("heading", { name: "Oct 26" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Oct 25" })).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(screen.getByRole("heading", { name: "Oct 25" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Oct 26" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Show recent days" }).click();
  await expect.element(screen.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
});

it("switches the year calendar to measured app time without claiming time before tracking started", async () => {
  await using screen = await render(
    <UsageInsights overview={overview} activity={activity} timeZone="UTC" now={now} />,
  );
  await screen.getByRole("button", { name: "App time", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "October 25, 2026: App time not tracked" }))
    .toBeVisible();
  const today = screen.getByRole("button", { name: "October 26, 2026: 6h 32m app time" });
  await userEvent.hover(today);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "October 26, 2026 · 6h 32m app time · 200 generated tokens · $0.00 provider reported · $3.00 API estimate · 1 unpriced record",
    );
});

it("does not present unavailable provider history as a known zero", async () => {
  await using screen = await render(
    <UsageInsights
      overview={{
        ...overview,
        firstRecordedAt: null,
        daily: [],
        generatedTokens: { last24h: 0, last7d: 0, last30d: 0, lifetime: 0 },
      }}
      activity={activity}
      timeZone="UTC"
      now={now}
    />,
  );
  await expect
    .element(screen.getByText(/^No retained token history · past 365 days$/))
    .toBeVisible();
  await expect.element(screen.getByText(/No retained token history yet\./)).toBeVisible();
  await expect.element(screen.getByText("No recorded API usage yet.")).toBeVisible();
});
