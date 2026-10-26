import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthAccessTokenType,
  EnvironmentId,
  GroupId,
  GroupPeerEnvelope,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ThreadId,
} from "@t3tools/contracts";
import {
  PeerResourceRequest,
  PeerRpcOpen,
  type PeerConnectionState,
  type PeerChannel,
} from "@t3tools/contracts/minesPeer";
import {
  createPeerIdentity,
  signGroupPeerEnvelope,
  verifyGroupPeerEnvelope,
} from "@t3tools/shared/minesPeerTrust";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostSignaling from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as Remote from "./RemoteGroupTransport.ts";
import { peerLoopbackUrl } from "../peer/PeerLoopbackBridge.ts";

const localEnv = EnvironmentId.make("local");
const remoteEnv = EnvironmentId.make("remote");
const local = createPeerIdentity(new Uint8Array(32).fill(1), "Local");
const remote = createPeerIdentity(new Uint8Array(32).fill(2), "Remote");
const descriptor = {
  environmentId: remoteEnv,
  label: "Remote",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1",
  capabilities: { repositoryIdentity: true },
};
const decodeResource = Schema.decodeUnknownSync(PeerResourceRequest);
const decodeOpen = Schema.decodeUnknownSync(PeerRpcOpen);
const decodeEnvelope = Schema.decodeUnknownSync(GroupPeerEnvelope);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fixture(options: { wrongEnvironment?: boolean; unapproved?: boolean } = {}) {
  const secrets = new Map<string, Uint8Array>();
  const requests: Array<typeof PeerResourceRequest.Type> = [];
  const rpc: Array<GroupPeerEnvelope> = [];
  const rpcOpens: string[] = [];
  let connects = 0;
  let approved = !options.unapproved;
  const connect = () => {
    connects++;
    const subscriptions = new Map<PeerChannel, Set<(data: Uint8Array) => void>>();
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const emit = (channel: PeerChannel, data: unknown) => {
      for (const subscriber of subscriptions.get(channel) ?? [])
        subscriber(encoder.encode(JSON.stringify(data)));
    };
    return {
      remoteDeviceId: remote.device.deviceId,
      closed,
      close,
      subscribe: (channel, subscriber) => {
        const listeners = subscriptions.get(channel) ?? new Set();
        listeners.add(subscriber);
        subscriptions.set(channel, listeners);
        return () => {
          listeners.delete(subscriber);
        };
      },
      send: async (channel, data) => {
        const frame = JSON.parse(decoder.decode(data));
        if (channel === "resource") {
          const request = decodeResource(frame);
          requests.push(request);
          const response =
            request.path === "/.well-known/mines/environment"
              ? { ...descriptor, ...(options.wrongEnvironment ? { environmentId: "wrong" } : {}) }
              : request.path === "/oauth/token"
                ? {
                    access_token: "secret-scoped-token",
                    token_type: "Bearer",
                    issued_token_type: AuthAccessTokenType,
                    expires_in: 60,
                    scope: "orchestration:read orchestration:operate",
                  }
                : { ticket: "ticket-for-rpc", expiresAt: "2099-01-01T00:00:00.000Z" };
          emit("resource", {
            id: request.id,
            status: 200,
            headers: { "content-type": "application/json" },
            encoding: "base64",
            body: Buffer.from(JSON.stringify(response)).toString("base64"),
          });
        } else if (channel === "rpc") {
          if (frame.type === "mines.rpc.open") rpcOpens.push(decodeOpen(frame).path);
          for (const value of Array.isArray(frame) ? frame : [frame]) {
            if (value._tag === "Ping") emit("rpc", { _tag: "Pong" });
            if (value._tag === "Request") {
              const envelope = decodeEnvelope(value.payload);
              rpc.push(envelope);
              assert.isTrue(
                verifyGroupPeerEnvelope(
                  envelope,
                  local.device,
                  { environmentId: remoteEnv, deviceId: remote.device.deviceId },
                  envelope.issuedAt,
                ),
              );
              emit("rpc", {
                _tag: "Exit",
                requestId: value.id,
                exit: { _tag: "Success", value: { type: "ok" } },
              });
            }
          }
        }
      },
    } satisfies PeerSession;
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
      set: (name, data) =>
        Effect.sync(() => {
          secrets.set(name, data);
        }),
    }),
    Layer.mock(PeerTrustStore.PeerTrustStore)({
      identity: Effect.succeed(local),
      list: Effect.sync(() => (approved ? [remote.device] : [])),
    }),
    Layer.effect(
      HostSignaling.HostSignalingService,
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.make<PeerConnectionState>({
          configured: true,
          online: true,
          controlUrl: "https://control.test",
          accountId: "account",
          stunServers: [],
          failure: null,
        });
        return HostSignaling.HostSignalingService.of({
          state,
          authorizeSharedGroup: () => Effect.die("Unused shared group authorization"),
          connectSharedGroup: () => Effect.die("Unused shared group connection"),
          subscribeSharedGroupSessions: () => () => {},
          subscribeSessions: () => () => {},
          configure: () => Effect.void,
          start: Effect.void,
          disable: Effect.void,
          disconnectDevice: () => Effect.void,
          connect: () =>
            Effect.acquireRelease(Effect.sync(connect), (session) => Effect.sync(session.close)),
        });
      }),
    ),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(localEnv),
    }),
  );
  return {
    layer: Remote.layer.pipe(Layer.provide(dependencies)),
    requests,
    rpc,
    rpcOpens,
    secrets,
    connects: () => connects,
    revoke: () => {
      approved = false;
    },
  };
}
const input = {
  environmentId: remoteEnv,
  deviceId: remote.device.deviceId,
  pairingCode: "fresh-code",
};

it.effect(
  "negotiates the current orchestration protocol in the ticketed peer websocket upgrade",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const service = yield* Remote.RemoteGroupTransport;
      yield* service.connectHost(input);
      yield* service.request(remoteEnv, { type: "describe", threadId: ThreadId.make("thread") });
      assert.lengthOf(test.rpcOpens, 1);
      const upgrade = peerLoopbackUrl(3773, test.rpcOpens[0]!, true);
      assert.equal(upgrade.pathname, "/ws");
      assert.equal(upgrade.searchParams.get("wsTicket"), "ticket-for-rpc");
      assert.deepEqual(upgrade.searchParams.getAll(ORCHESTRATION_PROTOCOL_QUERY_PARAM), [
        String(ORCHESTRATION_PROTOCOL_VERSION),
      ]);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "pairs over the approved peer, retains only a scoped host secret, and reuses authenticated RPC for stable deliveries",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Remote.RemoteGroupTransport;
        const route = yield* service.connectHost(input);
        assert.deepEqual(route, {
          environmentId: remoteEnv,
          deviceId: remote.device.deviceId,
          label: "Remote",
        });
        assert.notInclude(JSON.stringify(yield* service.listHostRoutes), "secret-scoped-token");
        const exchange = test.requests.find((request) => request.path === "/oauth/token")!;
        const form = new URLSearchParams(Buffer.from(exchange.body!, "base64").toString());
        assert.equal(form.get("subject_token"), "fresh-code");
        assert.equal(form.get("scope"), "orchestration:read orchestration:operate");
        const request = {
          type: "dispatch" as const,
          groupId: GroupId.make("group"),
          memberId: "member",
          threadId: ThreadId.make("thread"),
          deliveryId: "stable-delivery",
          prompt: "Continue",
          handoff: false,
        };
        yield* service.request(remoteEnv, request);
        yield* service.request(remoteEnv, request);
        assert.equal(test.connects(), 2);
        assert.lengthOf(test.rpc, 2);
        assert.deepEqual(test.rpc[0]!.request, test.rpc[1]!.request);
        assert.notEqual(test.rpc[0]!.nonce, test.rpc[1]!.nonce);
        assert.equal(
          test.requests.find((request) => request.path === "/api/auth/websocket-ticket/rpc")!
            .headers.authorization,
          "Bearer secret-scoped-token",
        );
        yield* service.disconnectHost({ environmentId: remoteEnv });
        assert.deepEqual(yield* service.listHostRoutes, { routes: [] });
        assert.equal(
          (yield* service.request(remoteEnv, request).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "does not spend a one-time grant when device approval or the remote environment does not match",
  () =>
    Effect.gen(function* () {
      for (const options of [{ wrongEnvironment: true }, { unapproved: true }]) {
        const test = fixture(options);
        const result = yield* Remote.RemoteGroupTransport.pipe(
          Effect.flatMap((service) => service.connectHost(input)),
          Effect.provide(test.layer),
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        assert.isFalse(test.requests.some((request) => request.path === "/oauth/token"));
        assert.equal(test.secrets.size, 0);
      }
    }),
);

it.effect(
  "authenticates caller environment, destination and request body and observes device revocation",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Remote.RemoteGroupTransport;
        yield* service.connectHost(input);
        const envelope = signGroupPeerEnvelope(remote, {
          fromEnvironmentId: remoteEnv,
          toEnvironmentId: localEnv,
          toDeviceId: local.device.deviceId,
          issuedAt: 0,
          nonce: "unique-test-message",
          request: { type: "describe", threadId: ThreadId.make("thread") },
        });
        assert.equal((yield* service.verify(envelope)).environmentId, remoteEnv);
        for (const forged of [
          { ...envelope, fromEnvironmentId: EnvironmentId.make("other") },
          { ...envelope, toEnvironmentId: remoteEnv },
          { ...envelope, request: { type: "describe" as const, threadId: ThreadId.make("other") } },
          { ...envelope, issuedAt: -61 },
        ])
          assert.equal((yield* service.verify(forged).pipe(Effect.result))._tag, "Failure");
        test.revoke();
        assert.equal((yield* service.verify(envelope).pipe(Effect.result))._tag, "Failure");
      }).pipe(Effect.provide(test.layer));
    }),
);
