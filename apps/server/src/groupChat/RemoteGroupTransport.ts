import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  GroupChatError,
  GroupConnectHostInput,
  GroupHostRoute,
  GroupPeerEnvelope,
  GroupPeerResponse,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type GroupPeerRequest,
} from "@t3tools/contracts";
import { peerFetch, layerPeerSocket } from "@t3tools/shared/minesPeerAdapters";
import { flushCatalogSession } from "@t3tools/client-runtime/catalog/peer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as SharedGroupTransport from "./SharedGroupTransport.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostSignaling from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import { signGroupPeerEnvelope, verifyGroupPeerEnvelope } from "@t3tools/shared/minesPeerTrust";

const StoredRoute = Schema.Struct({ ...GroupHostRoute.fields, token: Schema.String });
type StoredRoute = typeof StoredRoute.Type;
const RoutesJson = Schema.fromJsonString(Schema.Array(StoredRoute));
const decodeRoutes = Schema.decodeUnknownEffect(RoutesJson);
const encodeRoutes = Schema.encodeEffect(RoutesJson);
const decodeConnectInput = Schema.decodeEffect(GroupConnectHostInput);
const decodeEnvelope = Schema.decodeEffect(GroupPeerEnvelope);
const isGroupChatError = Schema.is(GroupChatError);
const PeerRpc = RpcGroup.make(
  Rpc.make("groups.peer", {
    payload: GroupPeerEnvelope,
    success: GroupPeerResponse,
    error: Schema.Union([GroupChatError, EnvironmentAuthorizationError]),
  }),
);
const makeClient = RpcClient.make(PeerRpc);
type Client = Effect.Success<typeof makeClient>;
const baseUrl = "http://127.0.0.1";
const unavailable = () =>
  new GroupChatError({
    code: "dispatch",
    message:
      "The paired group host is unavailable or its access has expired. Reconnect it in Connections, then retry this delivery.",
  });
const storageError = () =>
  new GroupChatError({
    code: "storage",
    message: "The paired host credential could not be stored securely.",
  });
const unauthorized = () =>
  new GroupChatError({
    code: "dispatch",
    message: "This group request is not from an approved, paired host.",
  });

export class RemoteGroupTransport extends Context.Service<
  RemoteGroupTransport,
  {
    readonly request: (
      environmentId: EnvironmentId,
      input: GroupPeerRequest,
    ) => Effect.Effect<GroupPeerResponse, GroupChatError>;
    readonly changes: Stream.Stream<EnvironmentId>;
    readonly connectHost: (
      input: GroupConnectHostInput,
    ) => Effect.Effect<GroupHostRoute, GroupChatError>;
    readonly listHostRoutes: Effect.Effect<
      { readonly routes: ReadonlyArray<GroupHostRoute> },
      GroupChatError
    >;
    readonly disconnectHost: (input: {
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<void, GroupChatError>;
    readonly verify: (
      input: GroupPeerEnvelope,
    ) => Effect.Effect<
      { readonly environmentId: EnvironmentId; readonly request: GroupPeerRequest },
      GroupChatError
    >;
  }
>()("mines/groupChat/RemoteGroupTransport") {}

const make = Effect.gen(function* () {
  const parentScope = yield* Scope.Scope;
  const shared = yield* Effect.serviceOption(SharedGroupTransport.SharedGroupTransport);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const signaling = yield* HostSignaling.HostSignalingService;
  const local = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* local.getEnvironmentId;
  const changes = yield* PubSub.sliding<EnvironmentId>(64);
  const routesLock = yield* Semaphore.make(1);
  const connectLocks = new Map<EnvironmentId, Semaphore.Semaphore>();
  const connectionLock = (id: EnvironmentId) => {
    const current = connectLocks.get(id);
    if (current) return current;
    const created = Semaphore.makeUnsafe(1);
    connectLocks.set(id, created);
    return created;
  };
  const connections = new Map<
    EnvironmentId,
    { readonly scope: Scope.Closeable; readonly client: Client; readonly session: PeerSession }
  >();
  const readRoutes = secrets.get("mines-group-host-routes").pipe(
    Effect.flatMap((stored) =>
      Option.isSome(stored)
        ? decodeRoutes(new TextDecoder().decode(stored.value))
        : Effect.succeed([] as ReadonlyArray<StoredRoute>),
    ),
    Effect.mapError(storageError),
  );
  const writeRoutes = (routes: ReadonlyArray<StoredRoute>) =>
    encodeRoutes(routes).pipe(
      Effect.flatMap((value) =>
        secrets.set("mines-group-host-routes", new TextEncoder().encode(value)),
      ),
      Effect.mapError(storageError),
    );
  const publicRoute = ({ token: _token, ...route }: StoredRoute): GroupHostRoute => route;
  const approvedDevice = Effect.fn("RemoteGroupTransport.approvedDevice")(function* (
    deviceId: string,
  ) {
    const device = (yield* trust.list.pipe(Effect.mapError(unauthorized))).find(
      (item) => item.deviceId === deviceId,
    );
    if (!device) return yield* unauthorized();
    return device;
  });
  const jsonRequest = Effect.fn("RemoteGroupTransport.jsonRequest")(function* (
    session: PeerSession,
    path: string,
    init: RequestInit = {},
  ) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await peerFetch(session, baseUrl)(`${baseUrl}${path}`, {
          ...init,
          signal,
        });
        if (!response.ok) throw new Error("Peer request refused");
        return (await response.json()) as unknown;
      },
      catch: unavailable,
    }).pipe(Effect.timeout("15 seconds"), Effect.mapError(unavailable));
  });
  const checkDescriptor = Effect.fn("RemoteGroupTransport.checkDescriptor")(function* (
    session: PeerSession,
    expected: EnvironmentId,
  ) {
    const descriptor = yield* jsonRequest(session, "/.well-known/mines/environment").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)),
      Effect.mapError(unavailable),
    );
    if (descriptor.environmentId !== expected) return yield* unauthorized();
    return descriptor;
  });
  const closeConnection = Effect.fn("RemoteGroupTransport.closeConnection")(function* (
    id: EnvironmentId,
  ) {
    const existing = connections.get(id);
    if (!existing) return;
    connections.delete(id);
    yield* Scope.close(existing.scope, Exit.void);
  });
  const connectHost = Effect.fn("RemoteGroupTransport.connectHost")(function* (
    input: GroupConnectHostInput,
  ) {
    yield* decodeConnectInput(input).pipe(Effect.mapError(unauthorized));
    if (input.environmentId === environmentId)
      return yield* new GroupChatError({
        code: "invalid-members",
        message: "Choose another computer for a remote host connection.",
      });
    yield* approvedDevice(input.deviceId);
    const route = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* signaling.connect(input.deviceId).pipe(Effect.mapError(unavailable));
        const descriptor = yield* checkDescriptor(session, input.environmentId);
        // A fresh one-time grant is exchanged directly; no existing browser credential is copied.
        const form = new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: input.pairingCode,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
          client_label: "Mines group coordinator",
          client_device_type: "desktop",
        });
        const token = yield* jsonRequest(session, "/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AuthAccessTokenResult)),
          Effect.mapError(unavailable),
        );
        const scopes = token.scope.split(/\s+/);
        if (
          token.token_type !== "Bearer" ||
          !scopes.includes(AuthOrchestrationReadScope) ||
          !scopes.includes(AuthOrchestrationOperateScope)
        )
          return yield* unauthorized();
        return {
          environmentId: input.environmentId,
          deviceId: input.deviceId,
          label: descriptor.label,
          token: token.access_token,
        } satisfies StoredRoute;
      }),
    );
    yield* routesLock.withPermit(
      Effect.gen(function* () {
        const routes = yield* readRoutes;
        if (
          routes.some(
            (item) =>
              item.deviceId === route.deviceId && item.environmentId !== route.environmentId,
          )
        )
          return yield* unauthorized();
        yield* writeRoutes([
          ...routes.filter((item) => item.environmentId !== route.environmentId),
          route,
        ]);
      }),
    );
    yield* connectionLock(route.environmentId).withPermit(closeConnection(route.environmentId));
    yield* PubSub.publish(changes, route.environmentId);
    return publicRoute(route);
  });
  const getConnection = Effect.fn("RemoteGroupTransport.getConnection")(function* (
    route: StoredRoute,
  ) {
    return yield* connectionLock(route.environmentId).withPermit(
      Effect.gen(function* () {
        const configured = (yield* readRoutes).find(
          (item) => item.environmentId === route.environmentId,
        );
        if (
          !configured ||
          configured.deviceId !== route.deviceId ||
          configured.token !== route.token
        )
          return yield* unauthorized();
        yield* approvedDevice(route.deviceId);
        const current = connections.get(route.environmentId);
        if (current) return current.client;
        const scope = yield* Scope.make();
        yield* Scope.addFinalizer(parentScope, Scope.close(scope, Exit.void));
        const connection = yield* Effect.gen(function* () {
          const session = yield* signaling
            .connect(route.deviceId)
            .pipe(Effect.mapError(unavailable));
          if (session.remoteDeviceId !== route.deviceId) {
            session.close();
            return yield* unauthorized();
          }
          yield* checkDescriptor(session, route.environmentId);
          const ticket = yield* jsonRequest(session, "/api/auth/websocket-ticket/rpc", {
            method: "POST",
            headers: { authorization: `Bearer ${route.token}` },
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.toCodecJson(AuthWebSocketTicketResult)),
            ),
            Effect.mapError(unavailable),
          );
          const socket = new URL("ws://127.0.0.1/ws");
          socket.searchParams.set("wsTicket", ticket.ticket);
          socket.searchParams.set(
            ORCHESTRATION_PROTOCOL_QUERY_PARAM,
            String(ORCHESTRATION_PROTOCOL_VERSION),
          );
          const protocol = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
              pingTimeout: "15 seconds",
              retryTransientErrors: false,
              retryPolicy: Schedule.recurs(0),
            }),
          ).pipe(
            Layer.provide(
              Layer.merge(layerPeerSocket(session, socket.toString()), RpcSerialization.layerJson),
            ),
          );
          const protocolContext = yield* Layer.build(protocol);
          const client = yield* makeClient.pipe(Effect.provide(protocolContext));
          return { scope, client, session };
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        connections.set(route.environmentId, connection);
        yield* PubSub.publish(changes, route.environmentId);
        yield* Effect.promise(() => connection.session.closed).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (connections.get(route.environmentId) === connection)
                connections.delete(route.environmentId);
              yield* Scope.close(scope, Exit.void);
              yield* PubSub.publish(changes, route.environmentId);
            }),
          ),
          Effect.forkIn(parentScope),
        );
        return connection.client;
      }),
    );
  });
  const request = Effect.fn("RemoteGroupTransport.request")(function* (
    id: EnvironmentId,
    input: GroupPeerRequest,
  ) {
    if (id.startsWith("shared-group:")) {
      if (Option.isNone(shared)) return yield* unavailable();
      return yield* shared.value.native(id, input);
    }
    const route = (yield* readRoutes).find((item) => item.environmentId === id);
    if (!route)
      return yield* new GroupChatError({
        code: "dispatch",
        message: "Connect this coordinator to the member's host in Settings → Connections first.",
      });
    const client = yield* getConnection(route);
    if (
      input.type === "dispatch" &&
      input.catalogContextRevision &&
      !input.contextContinuationOfRunId
    ) {
      const session = connections.get(id)?.session;
      if (!session) return yield* unavailable();
      const revision = input.catalogContextRevision;
      yield* Effect.tryPromise({
        try: (signal) =>
          flushCatalogSession(
            session,
            revision.accountId,
            Buffer.from(revision.stateVector, "base64"),
            signal,
          ),
        catch: () =>
          new GroupChatError({
            code: "dispatch",
            message:
              "Project context has not synchronized with this member's computer. Reconnect it, then retry this delivery.",
          }),
      }).pipe(
        Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unavailable()) }),
      );
    }
    const identity = yield* trust.identity.pipe(Effect.mapError(unauthorized));
    const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const signed = yield* Effect.try({
      try: () =>
        signGroupPeerEnvelope(identity, {
          fromEnvironmentId: environmentId,
          toEnvironmentId: id,
          toDeviceId: route.deviceId,
          issuedAt,
          nonce,
          request: input,
        }),
      catch: unauthorized,
    });
    return yield* client["groups.peer"](signed).pipe(
      Effect.timeout("45 seconds"),
      Effect.mapError((error) => (isGroupChatError(error) ? error : unavailable())),
      Effect.onError(() => closeConnection(id)),
    );
  });
  const verify = Effect.fn("RemoteGroupTransport.verify")(function* (input: GroupPeerEnvelope) {
    const envelope = yield* decodeEnvelope(input).pipe(Effect.mapError(unauthorized));
    const route = (yield* readRoutes).find(
      (item) =>
        item.environmentId === envelope.fromEnvironmentId &&
        item.deviceId === envelope.fromDeviceId,
    );
    if (!route) return yield* unauthorized();
    const approved = yield* approvedDevice(route.deviceId);
    const identity = yield* trust.identity.pipe(Effect.mapError(unauthorized));
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const verified = yield* Effect.try({
      try: () =>
        verifyGroupPeerEnvelope(
          envelope,
          approved,
          { environmentId, deviceId: identity.device.deviceId },
          time,
        ),
      catch: unauthorized,
    });
    if (!verified) return yield* unauthorized();
    return { environmentId: route.environmentId, request: envelope.request };
  });
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  return RemoteGroupTransport.of({
    request,
    verify,
    connectHost,
    changes: Stream.fromPubSub(changes),
    listHostRoutes: readRoutes.pipe(Effect.map((routes) => ({ routes: routes.map(publicRoute) }))),
    disconnectHost: Effect.fn("RemoteGroupTransport.disconnectHost")(function* ({
      environmentId: id,
    }) {
      yield* routesLock.withPermit(
        Effect.gen(function* () {
          yield* writeRoutes((yield* readRoutes).filter((route) => route.environmentId !== id));
        }),
      );
      yield* connectionLock(id).withPermit(closeConnection(id));
      yield* PubSub.publish(changes, id);
    }),
  });
});

export const layer = Layer.effect(RemoteGroupTransport, make);
