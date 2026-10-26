import { expect, it } from "@effect/vitest";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";

it.effect("keeps host identities and approved devices isolated across accounts and restarts", () =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    let sequence = 0;
    const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          stored.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          stored.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          stored.delete(name);
        }),
      getOrCreateRandom: (name, size) =>
        Effect.sync(() => {
          const existing = stored.get(name);
          if (existing) return existing;
          const value = new Uint8Array(size).fill(++sequence);
          stored.set(name, value);
          return value;
        }),
    });
    const phone = createPeerIdentity(new Uint8Array(32).fill(99), "Phone").device;
    const first = yield* Effect.gen(function* () {
      const trust = yield* PeerTrustStore.PeerTrustStore;
      yield* trust.selectAccount("account-a");
      const identity = yield* trust.identity;
      yield* trust.approve(phone);
      yield* trust.selectAccount("account-b");
      expect((yield* trust.identity).device.deviceId).not.toBe(identity.device.deviceId);
      expect(yield* trust.list).toEqual([]);
      yield* trust.selectAccount(null);
      expect(yield* trust.list).toEqual([]);
      yield* trust.selectAccount("account-a");
      expect((yield* trust.identity).device).toEqual(identity.device);
      expect(yield* trust.list).toEqual([phone]);
      return identity;
    }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(secrets))));
    yield* Effect.gen(function* () {
      const trust = yield* PeerTrustStore.PeerTrustStore;
      expect((yield* trust.identity).device).toEqual(first.device);
      expect(yield* trust.list).toEqual([phone]);
      yield* trust.revoke(phone.deviceId);
      expect(yield* trust.list).toEqual([]);
    }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(secrets))));
  }),
);
