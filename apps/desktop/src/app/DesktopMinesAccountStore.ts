import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";

export class MinesAccountStoreError extends Schema.TaggedError<MinesAccountStoreError>()(
  "MinesAccountStoreError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isMinesAccountStoreError = Schema.is(MinesAccountStoreError);

export class DesktopMinesAccountStore extends Context.Service<
  DesktopMinesAccountStore,
  {
    readonly get: Effect.Effect<string | null, MinesAccountStoreError>;
    readonly set: (token: string | null) => Effect.Effect<void, MinesAccountStoreError>;
  }
>()("@t3tools/desktop/app/DesktopMinesAccountStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment;
  const secure = yield* ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const file = path.join(environment.stateDir, "mines-account.encrypted");
  const protect = Effect.fn("mines.account.protect")(function* () {
    if (
      !(yield* secure.isEncryptionAvailable) ||
      Option.getOrNull(yield* secure.selectedStorageBackend) === "basic_text"
    ) {
      return yield* new MinesAccountStoreError({
        message: "Unlock system secure storage before signing in.",
      });
    }
  });
  const mapError = (cause: unknown) =>
    isMinesAccountStoreError(cause)
      ? cause
      : new MinesAccountStoreError({
          message: "Could not access the saved account session.",
          cause,
        });

  return DesktopMinesAccountStore.of({
    get: Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return null;
      yield* protect();
      return yield* secure.decryptString(yield* fs.readFile(file));
    }).pipe(lock.withPermit, Effect.mapError(mapError), Effect.withSpan("mines.account.get")),
    set: Effect.fn("mines.account.set")(
      function* (token) {
        if (token === null) {
          yield* fs.remove(file, { force: true });
          return;
        }
        if (!/^\S{1,16384}$/u.test(token)) {
          return yield* new MinesAccountStoreError({ message: "Invalid account session." });
        }
        yield* protect();
        const encrypted = yield* secure.encryptString(token);
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        const temporary = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs.writeFile(temporary, encrypted, { mode: 0o600 });
        yield* fs
          .rename(temporary, file)
          .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
      },
      lock.withPermit,
      Effect.mapError(mapError),
    ),
  });
});

export const layer = Layer.effect(DesktopMinesAccountStore, make);
