import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { getMinesAccountToken, setMinesAccountToken } from "../ipc/methods/minesAccount.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as Account from "./DesktopMinesAccountStore.ts";

const scramble = (bytes: Uint8Array) => bytes.map((byte) => byte ^ 0x55);

function layerFor(baseDir: string, available = true, basicText = false) {
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
    selectedStorageBackend: basicText ? Effect.succeedSome("basic_text") : Effect.succeedNone,
    encryptString: (value) => Effect.succeed(scramble(new TextEncoder().encode(value))),
    decryptString: (bytes) => Effect.succeed(new TextDecoder().decode(scramble(bytes))),
  });
  return Account.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(environment, secure, NodeServices.layer)),
  );
}

const withDirectory = <A, E, R>(
  run: (directory: string) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* run(yield* fs.makeTempDirectoryScoped({ prefix: "mines-account-test-" }));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("desktop account session storage", () => {
  it.effect("encrypts the session through IPC and restores it after restarting the store", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const token = "private-session-token";
        yield* Effect.gen(function* () {
          assert.isNull(yield* getMinesAccountToken.handler(undefined));
          yield* setMinesAccountToken.handler(token);
        }).pipe(Effect.provide(layerFor(directory)));

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(directory, "userdata", "mines-account.encrypted");
        assert.notInclude(new TextDecoder().decode(yield* fs.readFile(file)), token);
        assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
        assert.deepEqual(yield* fs.readDirectory(path.dirname(file)), ["mines-account.encrypted"]);
        assert.equal(
          yield* getMinesAccountToken.handler(undefined).pipe(Effect.provide(layerFor(directory))),
          token,
        );
      }),
    ),
  );

  it.effect("clears the session even when secure storage becomes unavailable", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* setMinesAccountToken
          .handler("saved-session")
          .pipe(Effect.provide(layerFor(directory)));
        yield* Effect.gen(function* () {
          yield* setMinesAccountToken.handler(null);
          assert.isNull(yield* getMinesAccountToken.handler(undefined));
        }).pipe(Effect.provide(layerFor(directory, false)));
      }),
    ),
  );

  it.effect.each([
    { available: false, basicText: false },
    { available: true, basicText: true },
  ])("refuses insecure persistence ($available, $basicText)", ({ available, basicText }) =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const error = yield* setMinesAccountToken
          .handler("private-session")
          .pipe(
            Effect.asVoid,
            Effect.flip,
            Effect.provide(layerFor(directory, available, basicText)),
          );
        assert.instanceOf(error, Account.MinesAccountStoreError);
        assert.isNull(
          yield* getMinesAccountToken.handler(undefined).pipe(Effect.provide(layerFor(directory))),
        );
      }),
    ),
  );

  it.effect("rejects invalid replacement tokens without deleting the saved session", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        yield* setMinesAccountToken.handler("saved-session");
        for (const token of ["", "token with spaces", "x".repeat(16_385)]) {
          const error = yield* setMinesAccountToken.handler(token).pipe(Effect.asVoid, Effect.flip);
          assert.instanceOf(error, Account.MinesAccountStoreError);
        }
        assert.equal(yield* getMinesAccountToken.handler(undefined), "saved-session");
      }).pipe(Effect.provide(layerFor(directory))),
    ),
  );
});
