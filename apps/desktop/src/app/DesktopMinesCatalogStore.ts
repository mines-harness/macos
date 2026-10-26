import { mergeCatalogUpdates } from "@t3tools/client-runtime/catalog";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";

export class MinesCatalogStoreError extends Schema.TaggedError<MinesCatalogStoreError>()(
  "MinesCatalogStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isMinesCatalogStoreError = Schema.is(MinesCatalogStoreError);

export class DesktopMinesCatalogStore extends Context.Service<
  DesktopMinesCatalogStore,
  {
    readonly get: (accountId: string) => Effect.Effect<string | null, MinesCatalogStoreError>;
    readonly set: (
      accountId: string,
      snapshot: string,
      mergeCatalog?: boolean,
    ) => Effect.Effect<void | string, MinesCatalogStoreError>;
    readonly clear: (accountId: string) => Effect.Effect<void, MinesCatalogStoreError>;
  }
>()("@t3tools/desktop/app/DesktopMinesCatalogStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment;
  const secure = yield* ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const directory = path.join(environment.stateDir, "mines-catalogs");
  const writeLock = yield* Semaphore.make(1);
  const resolve = Effect.fn("mines.catalog.path")(function* (accountId: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(accountId))
      return yield* Effect.fail(
        new MinesCatalogStoreError({ message: "Invalid account identifier." }),
      );
    return path.join(directory, `${accountId}.encrypted`);
  });
  const protect = Effect.fn("mines.catalog.protect")(function* () {
    const available = yield* secure.isEncryptionAvailable;
    const backend = yield* secure.selectedStorageBackend;
    if (!available || Option.getOrNull(backend) === "basic_text") {
      return yield* Effect.fail(
        new MinesCatalogStoreError({
          message: "Unlock system secure storage before saving the sidebar.",
        }),
      );
    }
  });
  return DesktopMinesCatalogStore.of({
    get: Effect.fn("mines.catalog.get")(
      function* (accountId) {
        const file = yield* resolve(accountId);
        if (!(yield* fs.exists(file))) return null;
        yield* protect();
        return yield* secure.decryptString(yield* fs.readFile(file));
      },
      Effect.mapError((cause) =>
        isMinesCatalogStoreError(cause)
          ? cause
          : new MinesCatalogStoreError({ message: "Could not read the encrypted sidebar.", cause }),
      ),
    ),
    set: Effect.fn("mines.catalog.set")(
      function* (accountId, snapshot, mergeCatalog = false) {
        const file = yield* resolve(accountId);
        if (snapshot.length > 16 * 1024 * 1024 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(snapshot)) {
          return yield* Effect.fail(
            new MinesCatalogStoreError({ message: "Invalid sidebar snapshot." }),
          );
        }
        yield* protect();
        let saved = snapshot;
        if (mergeCatalog) {
          const updates = [Buffer.from(snapshot, "base64")];
          if (yield* fs.exists(file))
            updates.push(
              Buffer.from(yield* secure.decryptString(yield* fs.readFile(file)), "base64"),
            );
          saved = yield* Effect.try({
            try: () => Buffer.from(mergeCatalogUpdates(updates)).toString("base64"),
            catch: () => new MinesCatalogStoreError({ message: "Invalid sidebar snapshot." }),
          });
        }
        const encrypted = yield* secure.encryptString(saved);
        yield* fs.makeDirectory(directory, { recursive: true });
        const temporary = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs.writeFile(temporary, encrypted, { mode: 0o600 });
        yield* fs
          .rename(temporary, file)
          .pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
        return mergeCatalog ? saved : undefined;
      },
      writeLock.withPermit,
      Effect.mapError((cause) =>
        isMinesCatalogStoreError(cause)
          ? cause
          : new MinesCatalogStoreError({ message: "Could not save the encrypted sidebar.", cause }),
      ),
    ),
    clear: Effect.fn("mines.catalog.clear")(
      function* (accountId) {
        yield* fs.remove(yield* resolve(accountId), { force: true });
      },
      writeLock.withPermit,
      Effect.mapError((cause) =>
        isMinesCatalogStoreError(cause)
          ? cause
          : new MinesCatalogStoreError({ message: "Could not remove the sidebar cache.", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopMinesCatalogStore, make);
