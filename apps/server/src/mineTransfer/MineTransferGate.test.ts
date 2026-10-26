import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as MineTransferGate from "./MineTransferGate.ts";

it.layer(NodeServices.layer)("MineTransferGate", (it) => {
  it.effect("restores frozen mines before a new runtime accepts commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const config = yield* Effect.gen(function* () {
        return yield* ServerConfig.ServerConfig;
      }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
      const build = Effect.fn("test.buildTransferGate")(function* () {
        return Context.get(
          yield* Layer.build(
            MineTransferGate.layer.pipe(Layer.provide(ServerConfig.layer(config))),
          ),
          MineTransferGate.MineTransferGate,
        );
      });
      const threadId = ThreadId.make("thread:durable-transfer");
      const first = yield* build();
      yield* first.freeze(threadId, "durable-transfer-01");
      const restarted = yield* build();
      expect(yield* restarted.assertAvailable(threadId).pipe(Effect.flip)).toMatchObject({
        reason: "busy",
        transferId: "durable-transfer-01",
      });
      yield* restarted.unfreeze(threadId, "another-transfer-01");
      expect(yield* restarted.assertAvailable(threadId).pipe(Effect.flip)).toMatchObject({
        reason: "busy",
      });
      yield* restarted.unfreeze(threadId, "durable-transfer-01");
      const afterCancel = yield* build();
      yield* afterCancel.assertAvailable(threadId);
    }),
  );
  it.effect("checks dispatch from preloaded memory without reading the filesystem", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const config = yield* Effect.gen(function* () {
        return yield* ServerConfig.ServerConfig;
      }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
      const gate = Context.get(
        yield* Layer.build(MineTransferGate.layer.pipe(Layer.provide(ServerConfig.layer(config)))),
        MineTransferGate.MineTransferGate,
      );
      const threadId = ThreadId.make("thread:memory-transfer");
      yield* gate.freeze(threadId, "durable-transfer-02");
      yield* fs.remove(path.join(config.stateDir, "mine-transfers", "locks"), { recursive: true });
      expect(yield* gate.assertAvailable(threadId).pipe(Effect.flip)).toMatchObject({
        reason: "busy",
        transferId: "durable-transfer-02",
      });
    }),
  );
});
