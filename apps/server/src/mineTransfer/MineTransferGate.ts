import { MineTransferError, MineTransferId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

const isTransferError = Schema.is(MineTransferError);
const LockRecordJson = Schema.fromJsonString(
  Schema.Struct({ threadId: ThreadId, transferId: MineTransferId }),
);
const decodeLock = Schema.decodeUnknownEffect(LockRecordJson);
const encodeLock = Schema.encodeEffect(LockRecordJson);

export class MineTransferGate extends Context.Service<
  MineTransferGate,
  {
    readonly freeze: (
      threadId: ThreadId,
      transferId: string,
    ) => Effect.Effect<void, MineTransferError>;
    readonly unfreeze: (
      threadId: ThreadId,
      transferId: string,
    ) => Effect.Effect<void, MineTransferError>;
    readonly assertAvailable: (threadId: ThreadId) => Effect.Effect<void, MineTransferError>;
  }
>()("mines/mineTransfer/MineTransferGate") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const root = path.join(config.stateDir, "mine-transfers", "locks");
  const lockPath = Effect.fn("MineTransferGate.lockPath")(function* (threadId: ThreadId) {
    const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(threadId));
    return path.join(root, Buffer.from(hash).toString("hex"));
  });
  const active = new Map<ThreadId, string>();
  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return;
    for (const entry of yield* fs.readDirectory(root)) {
      if (entry.endsWith(".tmp")) continue;
      const record = yield* fs
        .readFileString(path.join(root, entry))
        .pipe(Effect.flatMap(decodeLock));
      active.set(record.threadId, record.transferId);
    }
  }).pipe(
    Effect.mapError(
      (cause) => new MineTransferError({ operation: "load-locks", reason: "io", cause }),
    ),
  );
  return MineTransferGate.of({
    freeze: Effect.fn("MineTransferGate.freeze")(
      function* (threadId, transferId) {
        const current = active.get(threadId);
        if (current !== undefined && current !== transferId)
          return yield* new MineTransferError({ operation: "freeze", reason: "busy", transferId });
        yield* fs.makeDirectory(root, { recursive: true });
        const target = yield* lockPath(threadId);
        yield* fs.writeFileString(`${target}.tmp`, yield* encodeLock({ threadId, transferId }));
        yield* fs.rename(`${target}.tmp`, target);
        active.set(threadId, transferId);
      },
      Effect.mapError((cause) =>
        isTransferError(cause)
          ? cause
          : new MineTransferError({ operation: "freeze", reason: "io", cause }),
      ),
    ),
    unfreeze: Effect.fn("MineTransferGate.unfreeze")(
      function* (threadId, transferId) {
        if (active.get(threadId) !== transferId) return;
        yield* fs.remove(yield* lockPath(threadId), { force: true });
        active.delete(threadId);
      },
      Effect.mapError((cause) =>
        isTransferError(cause)
          ? cause
          : new MineTransferError({ operation: "unfreeze", reason: "io", cause }),
      ),
    ),
    assertAvailable: Effect.fn("MineTransferGate.assertAvailable")(function* (threadId) {
      const transferId = active.get(threadId);
      if (transferId !== undefined)
        return yield* new MineTransferError({ operation: "dispatch", reason: "busy", transferId });
    }),
  });
});
export const layer = Layer.effect(MineTransferGate, make);
