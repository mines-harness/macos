// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto has no authenticated AES-GCM cipher API.
import * as NodeCrypto from "node:crypto";
import {
  catalogStateVectorIncludes,
  type HostCatalogLifecycle,
} from "@t3tools/client-runtime/catalog";
import { bindCatalogSession } from "@t3tools/client-runtime/catalog/peer";
import type { MinesCatalogSnapshot } from "@t3tools/contracts/minesCatalog";
import { openPersistedCatalog } from "@t3tools/client-runtime/catalog/persistence";
import {
  CatalogRpcError,
  type CatalogExchangeInput,
  type CatalogBindIdentityInput,
  type CatalogContextRevision,
} from "@t3tools/contracts/catalogRpc";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import * as CatalogIdentityVerifier from "./CatalogIdentityVerifier.ts";

export function encryptCatalog(
  bytes: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  accountId: string,
): Uint8Array {
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(accountId));
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}
export function decryptCatalog(bytes: Uint8Array, key: Uint8Array, accountId: string): Uint8Array {
  if (bytes.length < 28) throw new Error("Invalid encrypted catalog.");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
}
const failure = () =>
  new CatalogRpcError({ message: "The private sidebar could not synchronize with this computer." });
type Handle = Awaited<ReturnType<typeof openPersistedCatalog>>;
const Owner = Schema.Struct({ accountId: Schema.NullOr(Schema.String) });
const decodeOwner = Schema.decodeUnknownSync(Schema.fromJsonString(Owner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Owner));

export class HostCatalogService extends Context.Service<
  HostCatalogService,
  {
    readonly bindIdentity: (
      input: CatalogBindIdentityInput,
    ) => Effect.Effect<{ accountId: string | null }, CatalogRpcError>;
    readonly readOwnedSnapshot: (
      revision?: CatalogContextRevision,
    ) => Effect.Effect<
      { readonly accountId: string; readonly snapshot: MinesCatalogSnapshot },
      CatalogRpcError
    >;
    readonly exchange: (
      input: CatalogExchangeInput,
    ) => Effect.Effect<{ update: string; stateVector: string }, CatalogRpcError>;
    readonly updates: (accountId: string) => Stream.Stream<string, CatalogRpcError>;
    readonly applyHostLifecycle: (
      event: HostCatalogLifecycle,
    ) => Effect.Effect<void, CatalogRpcError>;
  }
>()("mines/catalog/HostCatalogService") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const signaling = yield* HostSignalingService.HostSignalingService;
  const verifier = yield* CatalogIdentityVerifier.CatalogIdentityVerifier;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const scope = yield* Scope.Scope;
  const run = Effect.runPromiseWith(context);
  const catalogs = new Map<string, Promise<Handle>>();
  const identityLock = yield* Semaphore.make(1);
  const ownerKey = "mines-catalog-owner-v1";
  const savedOwner = yield* secrets.get(ownerKey).pipe(Effect.mapError(failure));
  let boundOwner: string | null | undefined = Option.isSome(savedOwner)
    ? yield* Effect.try({
        try: () => decodeOwner(new TextDecoder().decode(savedOwner.value)).accountId,
        catch: failure,
      })
    : undefined;
  const identityListeners = new Set<() => void>();
  const owner = Effect.gen(function* () {
    if (boundOwner !== undefined) return boundOwner ?? "local-device";
    const state = yield* SubscriptionRef.get(signaling.state);
    return state.accountId ?? "local-device";
  });
  const createHandle = (accountId: string, name: string) =>
    run(
      Effect.gen(function* () {
        // Headless hosts protect the key with the existing 0700/0600 secret store.
        // Desktop renderer copies additionally use the OS credential store.
        const key = yield* secrets.getOrCreateRandom(`${name}-key`, 32);
        return yield* Effect.tryPromise({
          try: () =>
            openPersistedCatalog({
              storage: {
                read: async () => {
                  const value = await run(secrets.get(name));
                  return Option.isSome(value) ? decryptCatalog(value.value, key, accountId) : null;
                },
                write: async (bytes) => {
                  const iv = await run(crypto.randomBytes(12));
                  await run(secrets.set(name, encryptCatalog(bytes, key, iv, accountId)));
                },
                clear: () => run(secrets.remove(name)),
              },
            }),
          catch: failure,
        });
      }),
    );
  const lifecycle = yield* Effect.tryPromise({
    try: () => createHandle("host-lifecycle", "mines-host-lifecycle-v1"),
    catch: failure,
  });
  const open = (accountId: string) => {
    const existing = catalogs.get(accountId);
    if (existing) return existing;
    const name = `mines-catalog-${NodeCrypto.createHash("sha256").update(accountId).digest("hex")}`;
    const pending = createHandle(accountId, name).then(async (handle) => {
      handle.catalog.applyUpdate(lifecycle.catalog.encodeUpdate(), "host-lifecycle");
      await handle.flush();
      return handle;
    });
    catalogs.set(accountId, pending);
    void pending.catch(() => catalogs.delete(accountId));
    return pending;
  };
  const authorized = Effect.fn("HostCatalogService.authorized")(function* (accountId: string) {
    if ((yield* owner) !== accountId) return yield* failure();
    const handle = yield* Effect.tryPromise({ try: () => open(accountId), catch: failure });
    if ((yield* owner) !== accountId) return yield* failure();
    return handle;
  });
  const unsubscribe = signaling.subscribeSessions((session) => {
    const bind = Effect.gen(function* () {
      const accountId = yield* owner;
      const state = yield* SubscriptionRef.get(signaling.state);
      if (accountId === "local-device" || state.accountId !== accountId) return;
      const handle = yield* authorized(accountId);
      const disconnect = bindCatalogSession(handle.catalog, accountId, session);
      identityListeners.add(disconnect);
      void session.closed.then(() => {
        disconnect();
        identityListeners.delete(disconnect);
      });
    }).pipe(identityLock.withPermit, Effect.ignore);
    Effect.runForkWith(context)(Effect.forkIn(bind, scope));
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      unsubscribe();
      for (const stop of identityListeners) stop();
      identityListeners.clear();
      await Promise.allSettled([
        lifecycle.close(),
        ...[...catalogs.values()].map(async (pending) => (await pending).close()),
      ]);
    }),
  );
  return HostCatalogService.of({
    bindIdentity: Effect.fn("HostCatalogService.bindIdentity")(function* (input) {
      const accountId =
        input.bearerToken === null ? null : yield* verifier.verify(input.bearerToken);
      const previousOwner = yield* owner;
      const state = yield* SubscriptionRef.get(signaling.state);
      if (state.accountId !== null && state.accountId !== accountId)
        yield* signaling.disable.pipe(Effect.mapError(failure));
      if (boundOwner !== accountId) {
        yield* secrets
          .set(ownerKey, new TextEncoder().encode(encodeOwner({ accountId })))
          .pipe(Effect.mapError(failure));
        boundOwner = accountId;
        if (previousOwner !== (accountId ?? "local-device")) {
          for (const stop of identityListeners) stop();
          identityListeners.clear();
        }
      }
      return { accountId };
    }, identityLock.withPermit),
    readOwnedSnapshot: Effect.fn("HostCatalogService.readOwnedSnapshot")(function* (revision) {
      const accountId = yield* owner;
      const handle = yield* authorized(accountId);
      if ((yield* owner) !== accountId) return yield* failure();
      if (revision) {
        const synchronized = yield* Effect.try({
          try: () =>
            revision.accountId === accountId &&
            catalogStateVectorIncludes(
              handle.catalog.encodeStateVector(),
              Buffer.from(revision.stateVector, "base64"),
            ),
          catch: failure,
        });
        if (!synchronized)
          return yield* new CatalogRpcError({
            message:
              "Your latest instructions and sources have not synchronized with this computer. Reconnect and try again.",
          });
      }
      return { accountId, snapshot: handle.catalog.getSnapshot() };
    }, identityLock.withPermit),
    applyHostLifecycle: Effect.fn("HostCatalogService.applyHostLifecycle")(function* (event) {
      yield* Effect.tryPromise({
        try: async () => {
          lifecycle.catalog.applyHostLifecycle(event);
          await lifecycle.flush();
          await Promise.all(
            [...catalogs.values()].map(async (pending) => {
              const handle = await pending;
              handle.catalog.applyHostLifecycle(event);
              await handle.flush();
            }),
          );
        },
        catch: failure,
      });
    }),
    exchange: Effect.fn("HostCatalogService.exchange")(function* (input) {
      const handle = yield* authorized(input.accountId);
      return yield* Effect.tryPromise({
        try: async () => {
          if (input.update)
            handle.catalog.applyUpdate(Buffer.from(input.update, "base64"), "local-renderer");
          await handle.flush();
          return {
            update: Buffer.from(
              handle.catalog.encodeUpdate(Buffer.from(input.stateVector, "base64")),
            ).toString("base64"),
            stateVector: Buffer.from(handle.catalog.encodeStateVector()).toString("base64"),
          };
        },
        catch: failure,
      });
    }, identityLock.withPermit),
    updates: (accountId) =>
      Stream.callback<string, CatalogRpcError>((queue) =>
        Effect.gen(function* () {
          const { catalog } = yield* authorized(accountId);
          const stop = catalog.subscribeUpdates((update) => {
            Queue.offerUnsafe(queue, Buffer.from(update).toString("base64"));
          });
          Queue.offerUnsafe(queue, Buffer.from(catalog.encodeUpdate()).toString("base64"));
          const invalidate = () => {
            stop();
            Queue.endUnsafe(queue);
          };
          identityListeners.add(invalidate);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stop();
              identityListeners.delete(invalidate);
            }),
          );
        }).pipe(identityLock.withPermit),
      ),
  });
});
export const layer = Layer.effect(HostCatalogService, make);
