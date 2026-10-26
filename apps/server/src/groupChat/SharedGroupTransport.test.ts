import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, GroupId, ThreadId, GroupChatError, IsoDateTime } from "@t3tools/contracts";
import { PeerError, type PeerConnectionState } from "@t3tools/contracts/minesPeer";
import { SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import { createPeerIdentity, type PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import {
  fetchSharedGroupAccess,
  signSharedGroupAccessProof,
  verifySharedGroupAccessProof,
} from "@t3tools/shared/minesSharedGroupAccess";
import {
  createPeerSession,
  type PeerDataChannel,
  type PeerSession,
} from "@t3tools/shared/minesPeerTransport";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SharedGroupService from "./SharedGroupService.ts";
import * as GroupChatService from "./GroupChatService.ts";
import * as GroupPeerStore from "./GroupPeerStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { sharedGroupEnvironmentId } from "./sharedGroupPolicy.ts";
const isPeerError = Schema.is(PeerError);
const encodeGrant = Schema.encodeSync(Schema.fromJsonString(SharedGroupDeviceGrant));
import * as SharedGroupTransport from "./SharedGroupTransport.ts";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

function wires() {
  let firstMessage = (_value: Uint8Array) => {};
  let secondMessage = (_value: Uint8Array) => {};
  let firstClosed = () => {};
  let secondClosed = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    firstClosed();
    secondClosed();
  };
  const first: PeerDataChannel = {
    send: (value) => secondMessage(value),
    bufferedAmount: () => 0,
    onMessage: (listener) => {
      firstMessage = listener;
    },
    onBufferedLow: () => {},
    onClose: (listener) => {
      firstClosed = listener;
    },
    close,
  };
  const second: PeerDataChannel = {
    send: (value) => firstMessage(value),
    bufferedAmount: () => 0,
    onMessage: (listener) => {
      secondMessage = listener;
    },
    onBufferedLow: () => {},
    onClose: (listener) => {
      secondClosed = listener;
    },
    close,
  };
  return { first, second };
}
const fixture = Effect.gen(function* () {
  const owner = createPeerIdentity(new Uint8Array(32).fill(41), "Owner");
  const friend = createPeerIdentity(new Uint8Array(32).fill(42), "Friend");
  const groupKey = "group-key-123456789";
  const control = wires();
  const bulk = wires();
  const ownerSession = createPeerSession(
    friend.device.deviceId,
    control.first,
    bulk.first,
    () => {},
    ["shared-group"],
  );
  const friendSession = createPeerSession(
    owner.device.deviceId,
    control.second,
    bulk.second,
    () => {},
    ["shared-group"],
  );
  let ownerReceive = (_value: HostSignalingService.SharedGroupSession) => {};
  let revoked = false;
  let offline = false;
  let checks = 0;
  const grant = (identity: PeerIdentity, remote: PeerIdentity): SharedGroupDeviceGrant => ({
    groupKey,
    groupId: "group:shared",
    coordinatorEnvironmentId: "owner-environment",
    coordinatorDevice: owner.device,
    from: identity.device,
    to: remote.device,
    fromFriendId: identity === owner ? "mines-aaaaaaaaaaaaaaaaaaaa" : "mines-bbbbbbbbbbbbbbbbbbbb",
    toFriendId: remote === owner ? "mines-aaaaaaaaaaaaaaaaaaaa" : "mines-bbbbbbbbbbbbbbbbbbbb",
    updatedAt: IsoDateTime.make("2026-10-26T00:00:00.000Z"),
  });
  const state = yield* SubscriptionRef.make<PeerConnectionState>({
    configured: true,
    online: true,
    controlUrl: "https://control.test",
    accountId: "account",
    stunServers: [],
    failure: null,
  });
  const external = (identity: PeerIdentity, remote: PeerIdentity, session: PeerSession) => {
    const metadata = new Map<string, Uint8Array>();
    return Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(PeerTrustStore.PeerTrustStore)({ identity: Effect.succeed(identity) }),
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (key) => Effect.succeed(Option.fromUndefinedOr(metadata.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            metadata.set(key, value);
          }),
      }),
      Layer.mock(HostSignalingService.HostSignalingService)({
        state,
        subscribeSessions: () => () => {},
        authorizeSharedGroup: (key, id) =>
          Effect.suspend(() => {
            checks++;
            if (key !== groupKey || id !== remote.device.deviceId)
              return Effect.fail(new PeerError({ code: "unapproved-device" }));
            const proof = signSharedGroupAccessProof(identity, {
              groupKey: key,
              toDeviceId: id,
              issuedAt: 1000,
              nonce: `control-proof-${checks.toString().padStart(16, "0")}`,
            });
            verifySharedGroupAccessProof(proof, identity.device, 1000);
            return Effect.tryPromise({
              try: () =>
                fetchSharedGroupAccess(
                  "https://control.test",
                  proof,
                  undefined,
                  async () =>
                    new Response(encodeGrant(grant(identity, remote)), {
                      status: revoked ? 403 : offline ? 503 : 200,
                    }),
                ),
              catch: (error) =>
                isPeerError(error) ? error : new PeerError({ code: "direct-unavailable" }),
            });
          }),
        connectSharedGroup: () =>
          Effect.sync(() => {
            if (identity === friend)
              ownerReceive({ session: ownerSession, grant: grant(owner, friend) });
            return { session, grant: grant(identity, remote) };
          }),
        subscribeSharedGroupSessions: (listener) => {
          if (identity === owner) ownerReceive = listener;
          return () => {};
        },
      }),
    );
  };
  const ownerContext = yield* Layer.build(
    SharedGroupTransport.layer.pipe(Layer.provide(external(owner, friend, ownerSession))),
  );
  const friendContext = yield* Layer.build(
    SharedGroupTransport.layer.pipe(Layer.provide(external(friend, owner, friendSession))),
  );
  const coordinator = Context.get(ownerContext, SharedGroupTransport.SharedGroupTransport);
  const participant = Context.get(friendContext, SharedGroupTransport.SharedGroupTransport);
  return {
    coordinator,
    participant,
    owner,
    friend,
    groupKey,
    friendSession,
    revoke: () => {
      revoked = true;
    },
    offline: () => {
      offline = true;
    },
    online: () => {
      offline = false;
    },
    get checks() {
      return checks;
    },
  };
});

describe("shared group direct transport", () => {
  it.effect(
    "keeps selected chats on a real control outage and releases only their reservations on HTTP revocation",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const threadId = ThreadId.make("selected-local-chat");
        yield* h.participant.select(h.groupKey, [threadId], true);
        const dependencies = Layer.mergeAll(
          GroupPeerStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          Layer.mock(GroupChatService.GroupChatService)({}),
          Layer.mock(PeerTrustStore.PeerTrustStore)({ identity: Effect.succeed(h.friend) }),
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("friend-environment")),
          }),
          Layer.succeed(SharedGroupTransport.SharedGroupTransport, h.participant),
        );
        const context = yield* Layer.build(
          Layer.merge(SharedGroupService.layer.pipe(Layer.provide(dependencies)), dependencies),
        );
        const service = Context.get(context, SharedGroupService.SharedGroupService);
        const peers = Context.get(context, GroupPeerStore.GroupPeerStore);
        const input = { groupKey: h.groupKey, coordinatorDeviceId: h.owner.device.deviceId };
        yield* peers.reserve({
          coordinatorEnvironmentId: sharedGroupEnvironmentId(h.groupKey, h.owner.device.deviceId),
          groupId: GroupId.make("group:shared"),
          memberId: "member",
          threadId,
        });
        h.offline();
        expect((yield* service.get(input)).status).toBe("offline");
        expect(yield* h.participant.selected(h.groupKey)).toEqual([threadId]);
        h.online();
        h.revoke();
        expect(yield* service.get(input).pipe(Effect.flip)).toMatchObject({
          code: "not-group-turn",
        });
        expect(yield* h.participant.selected(h.groupKey)).toEqual([]);
        expect(yield* peers.membership(threadId)).toBeUndefined();
      }),
  );
  it.effect(
    "uses a verified group grant and scoped channel, without private RPC/catalog access",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const calls: string[] = [];
        h.coordinator.register(
          (grant, call) =>
            Effect.sync(() => {
              expect(grant.to.deviceId).toBe(h.friend.device.deviceId);
              calls.push(call.type);
              return { type: "ok" as const };
            }),
          () => Effect.void,
        );
        expect(
          yield* h.participant.request(h.groupKey, h.owner.device.deviceId, { type: "get" }),
        ).toEqual({ type: "ok" });
        expect(calls).toEqual(["get"]);
        expect(h.checks).toBeGreaterThanOrEqual(4);
        for (const channel of ["rpc", "resource", "catalog"] as const)
          yield* Effect.promise(() =>
            expect(h.friendSession.send(channel, new Uint8Array([1]))).rejects.toThrow(),
          );
        h.offline();
        expect(
          yield* h.participant
            .request(h.groupKey, h.owner.device.deviceId, { type: "get" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(GroupChatError);
        expect(calls).toEqual(["get"]);
      }),
  );
  it.effect(
    "rechecks consent before returning an in-flight reply and denies later calls after revoke",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        h.coordinator.register(
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ type: "ok" as const }),
            ),
          () => Effect.void,
        );
        const request = yield* h.participant
          .request(h.groupKey, h.owner.device.deviceId, { type: "get" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        h.revoke();
        yield* Deferred.succeed(finish, undefined);
        expect(yield* Fiber.join(request)).toBeInstanceOf(GroupChatError);
        expect(
          yield* h.participant
            .request(h.groupKey, h.owner.device.deviceId, { type: "get" })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not-group-turn" });
      }),
  );
});
