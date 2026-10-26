import { PeerError, type PeerDevice } from "@t3tools/contracts/minesPeer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

export class DeviceDirectory extends Context.Service<
  DeviceDirectory,
  {
    readonly initialize: Effect.Effect<void, PeerError>;
    readonly register: (accountId: string, device: PeerDevice) => Effect.Effect<void, PeerError>;
    readonly list: (accountId: string) => Effect.Effect<ReadonlyArray<PeerDevice>, PeerError>;
    readonly owner: (
      deviceId: string,
    ) => Effect.Effect<
      Option.Option<{ readonly accountId: string; readonly publicKey: string }>,
      PeerError
    >;
    readonly revoke: (accountId: string, deviceId: string) => Effect.Effect<void, PeerError>;
  }
>()("@mines/control/DeviceDirectory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mapError = () => new PeerError({ code: "unapproved-device" });
  return DeviceDirectory.of({
    owner: Effect.fn("DeviceDirectory.owner")((deviceId: string) =>
      sql<{
        account_id: string;
        public_key: string;
      }>`SELECT account_id, public_key FROM mines_devices WHERE device_id = ${deviceId} AND NOT revoked`.pipe(
        Effect.map((rows) =>
          rows[0]
            ? Option.some({ accountId: rows[0].account_id, publicKey: rows[0].public_key })
            : Option.none(),
        ),
        Effect.mapError(mapError),
      ),
    ),
    initialize: sql`CREATE TABLE IF NOT EXISTS mines_devices (
      device_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      label VARCHAR(80) NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE
    )`.pipe(
      Effect.andThen(
        sql`CREATE INDEX IF NOT EXISTS mines_devices_account ON mines_devices (account_id, device_id) WHERE NOT revoked`,
      ),
      Effect.asVoid,
      Effect.mapError(mapError),
    ),
    register: Effect.fn("DeviceDirectory.register")(function* (accountId, device) {
      const records = yield* sql<{
        device_id: string;
      }>`INSERT INTO mines_devices (device_id, account_id, public_key, label)
        VALUES (${device.deviceId}, ${accountId}, ${device.publicKey}, ${device.label})
        ON CONFLICT (device_id) DO UPDATE SET label = EXCLUDED.label, revoked = FALSE
        WHERE mines_devices.account_id = EXCLUDED.account_id AND mines_devices.public_key = EXCLUDED.public_key
        RETURNING device_id`.pipe(Effect.mapError(mapError));
      if (records.length === 0) return yield* new PeerError({ code: "unapproved-device" });
    }),
    list: Effect.fn("DeviceDirectory.list")((accountId: string) =>
      sql<{
        device_id: string;
        public_key: string;
        label: string;
      }>`SELECT device_id, public_key, label FROM mines_devices WHERE account_id = ${accountId} AND NOT revoked ORDER BY device_id LIMIT 100`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            deviceId: row.device_id,
            publicKey: row.public_key,
            label: row.label,
          })),
        ),
        Effect.mapError(mapError),
      ),
    ),
    revoke: Effect.fn("DeviceDirectory.revoke")((accountId: string, deviceId: string) =>
      sql`UPDATE mines_devices SET revoked = TRUE WHERE account_id = ${accountId} AND device_id = ${deviceId}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapError),
      ),
    ),
  });
});

export const layer = Layer.effect(DeviceDirectory, make);
