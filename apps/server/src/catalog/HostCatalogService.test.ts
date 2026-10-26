import * as NodeServices from "@effect/platform-node/NodeServices";
import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import { PeerError, type PeerConnectionState } from "@t3tools/contracts/minesPeer";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CatalogIdentityVerifier from "./CatalogIdentityVerifier.ts";
import { CatalogRpcError } from "@t3tools/contracts/catalogRpc";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  HostCatalogService,
  layer as hostCatalogLayer,
  decryptCatalog,
  encryptCatalog,
} from "./HostCatalogService.ts";

describe("host catalog authenticated encryption", () => {
  it("round trips private metadata without storing its cleartext", () => {
    const input = new TextEncoder().encode("Private project and thread names");
    const key = new Uint8Array(32).fill(7);
    const sealed = encryptCatalog(input, key, new Uint8Array(12).fill(2), "account-a");
    expect(new TextDecoder().decode(sealed)).not.toContain("Private project");
    expect(Uint8Array.from(decryptCatalog(sealed, key, "account-a"))).toEqual(input);
  });
  it("rejects a wrong account, wrong key, or modified ciphertext", () => {
    const key = new Uint8Array(32).fill(7);
    const sealed = encryptCatalog(
      new TextEncoder().encode("Private"),
      key,
      new Uint8Array(12).fill(2),
      "account-a",
    );
    expect(() => decryptCatalog(sealed, key, "account-b")).toThrow();
    expect(() => decryptCatalog(sealed, new Uint8Array(32).fill(8), "account-a")).toThrow();
    sealed[13] = sealed[13]! ^ 1;
    expect(() => decryptCatalog(sealed, key, "account-a")).toThrow();
  });
});

it.effect(
  "binds catalog RPCs to the verified owner and restores encrypted state after host restart",
  () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      const verificationStarted = yield* Deferred.make<void>();
      const finishVerification = yield* Deferred.make<void>();
      const state = yield* SubscriptionRef.make<PeerConnectionState>({
        configured: true,
        online: true,
        accountId: "account-a",
        controlUrl: "https://control.example",
        stunServers: [],
        failure: null,
      });
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(CatalogIdentityVerifier.CatalogIdentityVerifier, {
          verify: (token) =>
            token === "delayed-account-a"
              ? Deferred.succeed(verificationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(finishVerification)),
                  Effect.as("account-a"),
                )
              : token === "verified-account-a"
                ? Effect.succeed("account-a")
                : Effect.fail(new CatalogRpcError({ message: "Invalid mines identity." })),
        }),
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
          set: (name, bytes) =>
            Effect.sync(() => {
              secrets.set(name, bytes);
            }),
          create: (name, bytes) =>
            Effect.sync(() => {
              secrets.set(name, bytes);
            }),
          getOrCreateRandom: (name, length) =>
            Effect.sync(() => {
              const key = secrets.get(name) ?? new Uint8Array(length).fill(7);
              secrets.set(name, key);
              return key;
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
        Layer.succeed(HostSignalingService.HostSignalingService, {
          state,
          configure: () => Effect.void,
          disable: SubscriptionRef.update(state, (current) => ({
            ...current,
            configured: false,
            online: false,
            accountId: null,
          })),
          start: Effect.void,
          connect: () => Effect.fail(new PeerError({ code: "direct-unavailable" })),
          authorizeSharedGroup: () => Effect.die("Unused shared group authorization"),
          connectSharedGroup: () => Effect.die("Unused shared group connection"),
          subscribeSharedGroupSessions: () => () => {},
          subscribeSessions: () => () => {},
          disconnectDevice: () => Effect.void,
        }),
      );
      const catalog = new MinesCatalog();
      const sectionId = catalog.createSection("Private launch");
      catalog.pin(sectionId);
      catalog.upsert({ id: "deleted-thread", kind: "thread", title: "Never resurrect" });
      catalog.pin("deleted-thread");
      const run = <A, E>(effect: Effect.Effect<A, E, HostCatalogService>) =>
        effect.pipe(
          Effect.provide(hostCatalogLayer.pipe(Layer.provide(dependencies))),
          Effect.scoped,
        );
      yield* run(
        Effect.gen(function* () {
          const service = yield* HostCatalogService;
          yield* service.applyHostLifecycle({
            id: "deleted-thread",
            sequence: 8,
            state: "deleted",
          });
          const denied = yield* service
            .exchange({
              accountId: "account-b",
              stateVector: Buffer.from(catalog.encodeStateVector()).toString("base64"),
            })
            .pipe(Effect.flip);
          expect(denied._tag).toBe("CatalogRpcError");
          yield* service.exchange({
            accountId: "account-a",
            stateVector: Buffer.from(catalog.encodeStateVector()).toString("base64"),
            update: Buffer.from(catalog.encodeUpdate()).toString("base64"),
          });
          const owned = yield* service.readOwnedSnapshot();
          expect(owned.accountId).toBe("account-a");
          expect(owned.snapshot.entities.some((entity) => entity.title === "Private launch")).toBe(
            true,
          );
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            accountId: "account-b",
          }));
          const other = yield* service.readOwnedSnapshot();
          expect(other.accountId).toBe("account-b");
          expect(other.snapshot.entities).toEqual([]);
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            accountId: "account-a",
          }));
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            configured: false,
            online: false,
            accountId: null,
          }));
          yield* service.bindIdentity({ bearerToken: "verified-account-a" });
          const withoutSignaling = yield* service.readOwnedSnapshot();
          expect(withoutSignaling.accountId).toBe("account-a");
          expect(
            withoutSignaling.snapshot.entities.some((entity) => entity.title === "Private launch"),
          ).toBe(true);
          const invalid = yield* service
            .bindIdentity({ bearerToken: "claimed-account-b" })
            .pipe(Effect.flip);
          expect(invalid._tag).toBe("CatalogRpcError");
          expect((yield* service.readOwnedSnapshot()).accountId).toBe("account-a");
          yield* service.readOwnedSnapshot({
            accountId: "account-a",
            stateVector: Buffer.from(catalog.encodeStateVector()).toString("base64"),
          });
          catalog.setContextInstructions(sectionId, "Keep this instruction available.");
          const revision = {
            accountId: "account-a",
            stateVector: Buffer.from(catalog.encodeStateVector()).toString("base64"),
          };
          expect((yield* service.readOwnedSnapshot(revision).pipe(Effect.flip))._tag).toBe(
            "CatalogRpcError",
          );
          yield* service.exchange({
            ...revision,
            update: Buffer.from(catalog.encodeUpdate()).toString("base64"),
          });
          expect(
            (yield* service.readOwnedSnapshot(revision)).snapshot.contexts?.[0]?.instructions,
          ).toBe("Keep this instruction available.");
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            configured: true,
            accountId: "account-a",
          }));
          const received = yield* Queue.unbounded<string>();
          const updates = yield* service.updates("account-a").pipe(
            Stream.runForEach((value) => Queue.offer(received, value)),
            Effect.forkChild,
          );
          yield* Queue.take(received);
          yield* service.bindIdentity({ bearerToken: null });
          yield* Fiber.join(updates);
          expect((yield* SubscriptionRef.get(state)).accountId).toBeNull();
          expect((yield* service.readOwnedSnapshot()).accountId).toBe("local-device");
          expect((yield* service.readOwnedSnapshot()).snapshot.entities).toEqual([]);
          expect((yield* service.readOwnedSnapshot(revision).pipe(Effect.flip))._tag).toBe(
            "CatalogRpcError",
          );
          yield* service.bindIdentity({ bearerToken: "verified-account-a" });
        }),
      );
      const restored = new MinesCatalog();
      const result = yield* run(
        HostCatalogService.pipe(
          Effect.flatMap((service) =>
            service.exchange({
              accountId: "account-a",
              stateVector: Buffer.from(restored.encodeStateVector()).toString("base64"),
            }),
          ),
        ),
      );
      restored.applyUpdate(Buffer.from(result.update, "base64"));
      expect(restored.getSnapshot().pins[0]?.entity.title).toBe("Private launch");
      expect(restored.has("deleted-thread")).toBe(false);
      for (const [name, value] of secrets)
        if (!name.endsWith("-key"))
          expect(new TextDecoder().decode(value)).not.toContain("Private launch");
      yield* run(
        HostCatalogService.pipe(
          Effect.flatMap((service) => service.bindIdentity({ bearerToken: null })),
        ),
      );
      yield* SubscriptionRef.update(state, (current) => ({ ...current, accountId: "account-a" }));
      const afterSignedOutRestart = yield* run(
        HostCatalogService.pipe(Effect.flatMap((service) => service.readOwnedSnapshot())),
      );
      expect(afterSignedOutRestart.accountId).toBe("local-device");
      expect(afterSignedOutRestart.snapshot.entities).toEqual([]);
      yield* run(
        Effect.gen(function* () {
          const service = yield* HostCatalogService;
          const signIn = yield* service
            .bindIdentity({ bearerToken: "delayed-account-a" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(verificationStarted);
          const signOut = yield* service
            .bindIdentity({ bearerToken: null })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(finishVerification, undefined);
          yield* Fiber.join(signIn);
          yield* Fiber.join(signOut);
          expect((yield* service.readOwnedSnapshot()).accountId).toBe("local-device");
        }),
      );
    }),
);
