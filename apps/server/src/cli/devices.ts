import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { accountJsonFlag, formatAccountJson, runWithAccount } from "./account.ts";
import { authLocationFlags } from "./config.ts";

const list = Command.make("list", { ...authLocationFlags, json: accountJsonFlag }).pipe(
  Command.withDescription(
    "List your account's devices, signaling presence, and last direct checks.",
  ),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const devices = yield* account.devices;
        if (flags.json) {
          yield* Console.log(formatAccountJson({ devices }));
          return;
        }
        if (devices.length === 0) {
          yield* Console.log("No devices registered for this account.");
          return;
        }
        for (const entry of devices)
          yield* Console.log(
            `${entry.device.label}${entry.current ? " (this host)" : ""}\n  ${entry.device.deviceId}\n  Signaling: ${entry.signalingOnline ? "online" : "offline"}; direct: ${entry.status}${entry.checkedAt ? ` (checked ${entry.checkedAt})` : ""}`,
          );
      }),
    ),
  ),
);
const check = Command.make("check", {
  ...authLocationFlags,
  json: accountJsonFlag,
  deviceId: Argument.String("device-id"),
}).pipe(
  Command.withDescription("Test an approved device with a direct authenticated handshake."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const result = yield* account.checkDevice(flags.deviceId);
        yield* Console.log(
          flags.json
            ? formatAccountJson(result)
            : `${result.deviceId}: ${result.status}${result.failure ? ` (${result.failure})` : ""}`,
        );
      }),
    ),
  ),
);
export const devicesCommand = Command.make("devices").pipe(
  Command.withDescription("Find and check devices on your Mines account."),
  Command.withSubcommands([list, check]),
);
