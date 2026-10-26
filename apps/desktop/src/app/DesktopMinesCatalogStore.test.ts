import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as Catalog from "./DesktopMinesCatalogStore.ts";
import { setMinesCatalog } from "../ipc/methods/minesCatalog.ts";

const scramble = (bytes: Uint8Array) => bytes.map((byte) => byte ^ 0x55);
function layerFor(baseDir: string, available: boolean) {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.0.0",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ MINES_HOME: baseDir })),
    ),
  );
  const secure = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    selectedStorageBackend: Effect.succeedNone,
    encryptString: (value) => Effect.succeed(scramble(new TextEncoder().encode(value))),
    decryptString: (bytes) => Effect.succeed(new TextDecoder().decode(scramble(bytes))),
  });
  return Catalog.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environment, secure, NodeServices.layer)),
  );
}
const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | Catalog.DesktopMinesCatalogStore>,
  available = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-catalog-test-" });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, available)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("private desktop sidebar storage", () => {
  it.effect(
    "returns the merged snapshot through IPC while ordinary private writes return no value",
    () =>
      withStore(
        Effect.gen(function* () {
          const first = new MinesCatalog();
          first.createSection("First window");
          const second = new MinesCatalog();
          second.createSection("Second window");
          yield* setMinesCatalog.handler({
            accountId: "ipc-account",
            snapshot: Buffer.from(first.encodeUpdate()).toString("base64"),
            mergeCatalog: true,
          });
          const merged = yield* setMinesCatalog.handler({
            accountId: "ipc-account",
            snapshot: Buffer.from(second.encodeUpdate()).toString("base64"),
            mergeCatalog: true,
          });
          assert.isString(merged);
          const restored = new MinesCatalog();
          restored.applyUpdate(Buffer.from(String(merged), "base64"));
          assert.deepEqual(
            restored
              .getSnapshot()
              .entities.map((entity) => entity.title)
              .sort(),
            ["First window", "Second window"],
          );
          assert.isUndefined(
            yield* setMinesCatalog.handler({
              accountId: "private-history",
              snapshot: "U2VjcmV0",
            }),
          );
        }),
      ),
  );
  it.effect("writes only the OS-encrypted bytes and isolates records", () =>
    withStore(
      Effect.gen(function* () {
        const catalog = yield* Catalog.DesktopMinesCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const value = "U2VjcmV0IHByb2plY3Q=";
        yield* catalog.set("account-a", value);
        assert.equal(yield* catalog.get("account-a"), value);
        assert.isNull(yield* catalog.get("account-b"));
        const stored = yield* fs.readFile(
          path.join(environment.stateDir, "mines-catalogs", "account-a.encrypted"),
        );
        assert.notEqual(new TextDecoder().decode(stored), value);
        yield* catalog.clear("account-a");
        assert.isNull(yield* catalog.get("account-a"));
      }),
    ),
  );
  it.effect(
    "merges independent window writes and rejects malformed updates without replacing the record",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* Catalog.DesktopMinesCatalogStore;
          const a = new MinesCatalog();
          const b = new MinesCatalog();
          a.createSection("Window A");
          b.createSection("Window B");
          yield* Effect.all(
            [
              store.set("same-account", Buffer.from(a.encodeUpdate()).toString("base64"), true),
              store.set("same-account", Buffer.from(b.encodeUpdate()).toString("base64"), true),
            ],
            { concurrency: "unbounded" },
          );
          const stored = yield* store.get("same-account");
          assert.isNotNull(stored);
          const restored = new MinesCatalog();
          restored.applyUpdate(Buffer.from(stored!, "base64"));
          assert.deepEqual(
            restored
              .getSnapshot()
              .entities.map((entity) => entity.title)
              .sort(),
            ["Window A", "Window B"],
          );
          assert.equal(
            (yield* store.set("same-account", "AA==", true).pipe(Effect.flip)).message,
            "Invalid sidebar snapshot.",
          );
          assert.equal(yield* store.get("same-account"), stored);
        }),
      ),
  );
  it.effect("fails closed without secure storage and creates no record", () =>
    withStore(
      Effect.gen(function* () {
        const catalog = yield* Catalog.DesktopMinesCatalogStore;
        assert.isTrue(
          Option.isSome(yield* catalog.set("account-a", "AA==").pipe(Effect.flip, Effect.option)),
        );
        assert.isNull(yield* catalog.get("account-a"));
      }),
      false,
    ),
  );
  it.effect("rejects traversal and invalid snapshot payloads", () =>
    withStore(
      Effect.gen(function* () {
        const catalog = yield* Catalog.DesktopMinesCatalogStore;
        assert.equal(
          (yield* catalog.set("../outside", "AA==").pipe(Effect.flip)).message,
          "Invalid account identifier.",
        );
        assert.equal(
          (yield* catalog.set("account-a", "not base64!").pipe(Effect.flip)).message,
          "Invalid sidebar snapshot.",
        );
      }),
    ),
  );
});
