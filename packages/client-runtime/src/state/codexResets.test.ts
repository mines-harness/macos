import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import {
  CODEX_RESETS_URL,
  CodexResetStatus,
  describeCodexResetForecast,
  loadCodexResetStatus,
} from "./codexResets.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const OBSERVED_AT = "2026-10-26T10:00:00.000Z";
const EXPIRES_AT = "2026-10-27T10:00:00.000Z";
const decode = Schema.decodeUnknownSync(CodexResetStatus);

function status(data: Partial<CodexResetStatus["data"]> = {}): CodexResetStatus {
  return {
    data: { latest_reset: null, scheduled_reset: null, active_watch: null, ...data },
    meta: { generated_at: OBSERVED_AT },
  };
}

function watch(chance: number | null = 80): NonNullable<CodexResetStatus["data"]["active_watch"]> {
  return {
    reset_chance_percent: chance,
    forecast_window: "next 24 hours",
    observed_at: OBSERVED_AT,
    expires_at: EXPIRES_AT,
  };
}

describe("Codex reset status", () => {
  it.each(["regular", "banked"] as const)(
    "decodes a %s reset and tolerates API additions",
    (type) => {
      const body = status({ latest_reset: { reset_type: type, announced_at: OBSERVED_AT } });
      const result = decode({
        ...body,
        data: { ...body.data, stats: { total: 68 } },
        meta: { ...body.meta, api_version: "v1" },
      });
      expect(result.data.latest_reset).toEqual({ reset_type: type, announced_at: OBSERVED_AT });
    },
  );

  it("leaves absent forecasts unknown instead of inventing a zero chance", () => {
    expect(describeCodexResetForecast(decode(status()), NOW)).toBe("No reset forecast");
  });

  it.each([0, 80, 100])("keeps a valid %s%% forecast", (chance) => {
    expect(describeCodexResetForecast(decode(status({ active_watch: watch(chance) })), NOW)).toBe(
      `Reset chance: ${chance}% · next 24 hours`,
    );
  });

  it("shows a watch without inventing its probability", () => {
    expect(describeCodexResetForecast(status({ active_watch: watch(null) }), NOW)).toBe(
      "Reset watch · next 24 hours",
    );
  });

  it.each([-1, 101, 80.5, "80"])("rejects invalid reset probability %s", (chance) => {
    const body = status();
    expect(() =>
      decode({
        ...body,
        data: { ...body.data, active_watch: { ...watch(), reset_chance_percent: chance } },
      }),
    ).toThrow();
  });

  it.each(["not a date", "2026-13-26T10:00:00Z", "2026-02-30T10:00:00Z", "2026-10-26"])(
    "rejects malformed reset timestamp %s",
    (timestamp) => {
      expect(() =>
        decode(status({ latest_reset: { reset_type: "regular", announced_at: timestamp } })),
      ).toThrow();
    },
  );

  it("rejects unknown reset types instead of labelling them manual", () => {
    const body = status();
    expect(() =>
      decode({
        ...body,
        data: {
          ...body.data,
          latest_reset: { reset_type: "unknown", announced_at: OBSERVED_AT },
        },
      }),
    ).toThrow();
  });

  it("drops a cached forecast at its expiry even without another successful fetch", () => {
    const cached = status({ active_watch: watch() });
    expect(describeCodexResetForecast(cached, Date.parse(EXPIRES_AT))).toBe("No reset forecast");
  });

  it("does not show a watch before its observation time", () => {
    expect(
      describeCodexResetForecast(status({ active_watch: watch() }), Date.parse(OBSERVED_AT) - 1),
    ).toBe("No reset forecast");
  });

  it("gives an explicit scheduled reset priority over a forecast", () => {
    expect(
      describeCodexResetForecast(
        status({ scheduled_reset: { scheduled_for: EXPIRES_AT }, active_watch: watch() }),
        NOW,
      ),
    ).toBe("Reset scheduled");
  });

  it.each([OBSERVED_AT, null])("keeps a %s schedule awaiting confirmation", (scheduledFor) => {
    const result = decode(status({ scheduled_reset: { scheduled_for: scheduledFor } }));
    expect(describeCodexResetForecast(result, NOW)).toBe("Scheduled reset awaiting confirmation");
    expect(result.data.latest_reset).toBeNull();
  });

  it.effect("loads the public endpoint without credentials or tracing headers", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const fetchFn = ((input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json(status({ active_watch: watch() })));
      }) satisfies typeof fetch;
      const result = yield* loadCodexResetStatus().pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetchFn),
      );
      expect(result.data.active_watch?.reset_chance_percent).toBe(80);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe(`${CODEX_RESETS_URL}/api/v1/status`);
      expect(request.credentials).toBe("omit");
      expect(request.cache).toBe("no-cache");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("traceparent")).toBeNull();
      expect(request.headers.get("b3")).toBeNull();
    }),
  );

  it.effect("fails on an unsuccessful HTTP status rather than using its body as data", () =>
    Effect.gen(function* () {
      const result = yield* loadCodexResetStatus().pipe(
        Effect.provideService(FetchHttpClient.Fetch, () =>
          Promise.resolve(Response.json(status(), { status: 503 })),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("fails on malformed data rather than displaying an invalid forecast", () =>
    Effect.gen(function* () {
      const result = yield* loadCodexResetStatus().pipe(
        Effect.provideService(FetchHttpClient.Fetch, () =>
          Promise.resolve(Response.json({ data: { active_watch: watch() } })),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("fails when the network is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* loadCodexResetStatus().pipe(
        Effect.provideService(FetchHttpClient.Fetch, () =>
          Promise.reject(new TypeError("Failed to fetch")),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect("times out a stalled request and aborts its fetch", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const signals: AbortSignal[] = [];
      const fetchFn = ((_input, init) => {
        if (init?.signal) signals.push(init.signal);
        Deferred.doneUnsafe(requested, Exit.void);
        return new Promise<Response>(() => {});
      }) satisfies typeof fetch;
      const fiber = yield* loadCodexResetStatus().pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetchFn),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust("10 seconds");
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
      expect(signals[0]?.aborted).toBe(true);
    }),
  );
});
