import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

export const CODEX_RESETS_URL = "https://codex-resets.com";

const IsoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => {
    if (!Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23) return false;
    const date = value.slice(0, 10);
    return DateTime.formatIsoDateUtc(DateTime.makeUnsafe(`${date}T00:00:00.000Z`)) === date;
  }),
);

export const CodexResetStatus = Schema.Struct({
  data: Schema.Struct({
    latest_reset: Schema.NullOr(
      Schema.Struct({
        reset_type: Schema.Literals(["regular", "banked"]),
        announced_at: IsoTimestamp,
      }),
    ),
    scheduled_reset: Schema.NullOr(
      Schema.Struct({
        scheduled_for: Schema.NullOr(IsoTimestamp),
      }),
    ),
    active_watch: Schema.NullOr(
      Schema.Struct({
        reset_chance_percent: Schema.NullOr(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
        ),
        forecast_window: Schema.String,
        observed_at: IsoTimestamp,
        expires_at: IsoTimestamp,
      }),
    ),
  }),
  meta: Schema.Struct({ generated_at: IsoTimestamp }),
});
export type CodexResetStatus = typeof CodexResetStatus.Type;

export const loadCodexResetStatus = Effect.fn("CodexResets.loadStatus")(
  function* () {
    const response = yield* HttpClient.get(`${CODEX_RESETS_URL}/api/v1/status`);
    const ok = yield* HttpClientResponse.filterStatusOk(response);
    return yield* HttpClientResponse.schemaBodyJson(CodexResetStatus)(ok);
  },
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "omit", cache: "no-cache" }),
  // Tracing headers would add an unnecessary CORS preflight to this public request.
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("10 seconds"),
);

export const codexResetStatusAtom = Atom.make(loadCodexResetStatus()).pipe(
  Atom.withRefresh("5 minutes"),
  Atom.withLabel("codex-reset-status"),
);

export function describeCodexResetForecast(status: CodexResetStatus, now: number): string {
  const scheduled = status.data.scheduled_reset;
  if (scheduled) {
    return scheduled.scheduled_for !== null && Date.parse(scheduled.scheduled_for) > now
      ? "Reset scheduled"
      : "Scheduled reset awaiting confirmation";
  }
  const watch = status.data.active_watch;
  if (!watch || Date.parse(watch.observed_at) > now || Date.parse(watch.expires_at) <= now) {
    return "No reset forecast";
  }
  const window = watch.forecast_window.trim() || "soon";
  return watch.reset_chance_percent === null
    ? `Reset watch · ${window}`
    : `Reset chance: ${watch.reset_chance_percent}% · ${window}`;
}
