import { PeerDevice, type PeerDevice as PeerDeviceType } from "@t3tools/contracts/minesPeer";
import {
  createPeerIdentity,
  peerAccountNamespace,
  type PeerIdentity,
} from "@t3tools/shared/minesPeerTrust";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class PeerTrustStore extends Context.Service<
  PeerTrustStore,
  {
    readonly selectAccount: (
      accountId: string | null,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly identity: Effect.Effect<PeerIdentity, ServerSecretStore.SecretStoreError>;
    readonly list: Effect.Effect<
      ReadonlyArray<PeerDeviceType>,
      ServerSecretStore.SecretStoreError | Schema.SchemaError
    >;
    readonly approve: (
      device: PeerDeviceType,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError | Schema.SchemaError>;
    readonly revoke: (
      deviceId: string,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError | Schema.SchemaError>;
  }
>()("mines/peer/PeerTrustStore") {}

const DevicesJson = Schema.fromJsonString(Schema.Array(PeerDevice));
const decodeDevices = Schema.decodeEffect(DevicesJson);
const encodeDevices = Schema.encodeEffect(DevicesJson);
const decodeDevice = Schema.decodeEffect(PeerDevice);
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const savedAccount = yield* secrets.get("mines-peer-account");
  let namespace = Option.isSome(savedAccount)
    ? new TextDecoder().decode(savedAccount.value)
    : "unassigned";
  const identity = Effect.suspend(() =>
    secrets
      .getOrCreateRandom(`mines-peer-identity-${namespace}`, 32)
      .pipe(Effect.map((key) => createPeerIdentity(key, "Mines computer"))),
  );
  const list = Effect.gen(function* () {
    const stored = yield* secrets.get(`mines-approved-peers-${namespace}`);
    return Option.isSome(stored)
      ? yield* decodeDevices(new TextDecoder().decode(stored.value))
      : [];
  });
  const save = Effect.fn("PeerTrustStore.save")(function* (devices: ReadonlyArray<PeerDeviceType>) {
    const value = yield* encodeDevices(devices);
    yield* secrets.set(`mines-approved-peers-${namespace}`, new TextEncoder().encode(value));
  });
  return PeerTrustStore.of({
    selectAccount: Effect.fn("PeerTrustStore.selectAccount")((accountId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const next = accountId === null ? "unassigned" : peerAccountNamespace(accountId);
          yield* secrets.set("mines-peer-account", new TextEncoder().encode(next));
          namespace = next;
        }),
      ),
    ),
    identity,
    list,
    approve: Effect.fn("PeerTrustStore.approve")(function* (device) {
      yield* decodeDevice(device);
      yield* lock.withPermit(
        Effect.gen(function* () {
          const devices = yield* list;
          yield* save([...devices.filter((entry) => entry.deviceId !== device.deviceId), device]);
        }),
      );
    }),
    revoke: Effect.fn("PeerTrustStore.revoke")(function* (deviceId) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          yield* save((yield* list).filter((device) => device.deviceId !== deviceId));
        }),
      );
    }),
  });
});

export const layer = Layer.effect(PeerTrustStore, make);
