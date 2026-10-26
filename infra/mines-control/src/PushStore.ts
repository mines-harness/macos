import { MinesPushError } from "@t3tools/shared/minesPush";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export class PushStore extends Context.Service<
  PushStore,
  {
    readonly initialize: Effect.Effect<void, MinesPushError>;
    readonly register: (
      account: string,
      deviceId: string,
      token: string,
    ) => Effect.Effect<void, MinesPushError>;
    readonly remove: (account: string, deviceId: string) => Effect.Effect<void, MinesPushError>;
    readonly targets: (
      account: string,
      sender: string,
    ) => Effect.Effect<ReadonlyArray<{ deviceId: string; token: string }>, MinesPushError>;
    readonly claim: (account: string, eventId: string) => Effect.Effect<boolean, MinesPushError>;
  }
>()("@mines/control/PushStore") {}
const failure = () => new MinesPushError({ code: "unavailable" });
export const layer = Layer.effect(
  PushStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PushStore.of({
      initialize: Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS mines_push_devices (device_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
        yield* sql`CREATE INDEX IF NOT EXISTS mines_push_account ON mines_push_devices(account_id)`;
        yield* sql`CREATE TABLE IF NOT EXISTS mines_push_events (account_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account_id, event_id))`;
        yield* sql`CREATE INDEX IF NOT EXISTS mines_push_event_expiry ON mines_push_events(created_at)`;
      }).pipe(Effect.mapError(failure)),
      register: (account, deviceId, token) =>
        sql`INSERT INTO mines_push_devices (device_id, account_id, token) VALUES (${deviceId}, ${account}, ${token}) ON CONFLICT(device_id) DO UPDATE SET token=EXCLUDED.token, updated_at=NOW() WHERE mines_push_devices.account_id=EXCLUDED.account_id`.pipe(
          Effect.asVoid,
          Effect.mapError(failure),
        ),
      remove: (account, deviceId) =>
        sql`DELETE FROM mines_push_devices WHERE account_id=${account} AND device_id=${deviceId}`.pipe(
          Effect.asVoid,
          Effect.mapError(failure),
        ),
      targets: (account, sender) =>
        sql<{
          device_id: string;
          token: string;
        }>`SELECT p.device_id, p.token FROM mines_push_devices p JOIN mines_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id WHERE p.account_id=${account} AND p.device_id<>${sender} AND NOT d.revoked AND p.updated_at>NOW()-INTERVAL '90 days' ORDER BY p.device_id LIMIT 20`.pipe(
          Effect.map((rows) => rows.map((row) => ({ deviceId: row.device_id, token: row.token }))),
          Effect.mapError(failure),
        ),
      claim: (account, eventId) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM mines_push_events WHERE created_at<NOW()-INTERVAL '1 day'`;
              yield* sql`DELETE FROM mines_push_devices WHERE updated_at<NOW()-INTERVAL '90 days'`;
              const rows =
                yield* sql`INSERT INTO mines_push_events(account_id,event_id) VALUES (${account},${eventId}) ON CONFLICT DO NOTHING RETURNING event_id`;
              return rows.length > 0;
            }),
          )
          .pipe(Effect.mapError(failure)),
    });
  }),
);
