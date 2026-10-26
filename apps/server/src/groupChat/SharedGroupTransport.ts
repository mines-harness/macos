import {
  EnvironmentId,
  GroupChatError,
  GroupPeerResponse,
  ThreadId,
  type GroupPeerRequest,
} from "@t3tools/contracts";
import { type SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import { SharedGroupPeerCall, SharedGroupPeerResult } from "@t3tools/contracts/sharedGroups";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import { sharedGroupEnvironmentId } from "./sharedGroupPolicy.ts";

const decodeNativeResponse = Schema.decodeUnknownEffect(GroupPeerResponse);
const unavailable = () =>
  new GroupChatError({
    code: "dispatch",
    message:
      "This shared group is offline or access has changed. Reconnect to its computer and try again.",
  });
const Frame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("request"), id: Schema.String, call: SharedGroupPeerCall }),
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.String,
    result: SharedGroupPeerResult,
  }),
  Schema.Struct({ type: Schema.Literal("error"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancel"), id: Schema.String }),
]);
const FrameJson = Schema.fromJsonString(Frame);
const decodeFrame = Schema.decodeUnknownSync(FrameJson);
const encodeFrame = Schema.encodeSync(FrameJson);
const Metadata = Schema.Struct({
  selected: Schema.Array(Schema.Struct({ groupKey: Schema.String, threadId: ThreadId })),
  routes: Schema.Array(Schema.Struct({ groupKey: Schema.String, deviceId: Schema.String })),
});
const MetadataJson = Schema.fromJsonString(Metadata);
const decodeMetadata = Schema.decodeUnknownEffect(MetadataJson);
const encodeMetadata = Schema.encodeEffect(MetadataJson);
type Cleanup = (
  grant: SharedGroupDeviceGrant,
  revoked: boolean,
) => Effect.Effect<void, GroupChatError>;
type Handler = (
  grant: SharedGroupDeviceGrant,
  call: SharedGroupPeerCall,
) => Effect.Effect<SharedGroupPeerResult, GroupChatError>;
interface Connection {
  readonly grant: SharedGroupDeviceGrant;
  readonly session: PeerSession;
  readonly pending: Map<string, Deferred.Deferred<SharedGroupPeerResult, GroupChatError>>;
}

export class SharedGroupTransport extends Context.Service<
  SharedGroupTransport,
  {
    readonly register: (handler: Handler, cleanup: Cleanup) => () => void;
    readonly request: (
      groupKey: string,
      deviceId: string,
      call: SharedGroupPeerCall,
    ) => Effect.Effect<SharedGroupPeerResult, GroupChatError>;
    readonly authorize: (
      groupKey: string,
      deviceId: string,
    ) => Effect.Effect<SharedGroupDeviceGrant, GroupChatError>;
    readonly bindRoute: (
      groupKey: string,
      deviceId: string,
    ) => Effect.Effect<EnvironmentId, GroupChatError>;
    readonly native: (
      environmentId: EnvironmentId,
      request: GroupPeerRequest,
    ) => Effect.Effect<GroupPeerResponse, GroupChatError>;
    readonly selected: (groupKey: string) => Effect.Effect<ReadonlyArray<ThreadId>, GroupChatError>;
    readonly select: (
      groupKey: string,
      threadIds: ReadonlyArray<ThreadId>,
      selected: boolean,
    ) => Effect.Effect<void, GroupChatError>;
    readonly disconnect: (groupKey: string) => Effect.Effect<void>;
  }
>()("mines/groupChat/SharedGroupTransport") {}

const make = Effect.gen(function* () {
  const signaling = yield* HostSignalingService.HostSignalingService;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const connections = new Map<string, Connection>();
  const opening = new Map<string, Semaphore.Semaphore>();
  const metadataLock = yield* Semaphore.make(1);
  let handler: Handler = () => Effect.fail(unavailable());
  let cleanup: Cleanup = () => Effect.void;
  const authorize = Effect.fn("SharedGroupTransport.authorize")(
    (groupKey: string, deviceId: string) =>
      signaling.authorizeSharedGroup(groupKey, deviceId).pipe(
        Effect.mapError((error) =>
          error.code === "unapproved-device"
            ? new GroupChatError({
                code: "not-group-turn",
                message: "Shared group access is no longer available.",
              })
            : unavailable(),
        ),
      ),
  );
  const read = Effect.fn("SharedGroupTransport.readMetadata")(function* () {
    const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
    const key = `mines-shared-groups:${identity.device.deviceId}`;
    const stored = yield* secrets.get(key).pipe(Effect.mapError(unavailable));
    const data = Option.isSome(stored)
      ? yield* decodeMetadata(new TextDecoder().decode(stored.value)).pipe(
          Effect.mapError(unavailable),
        )
      : { selected: [], routes: [] };
    return { key, data };
  });
  const write = Effect.fn("SharedGroupTransport.writeMetadata")(function* (
    key: string,
    data: typeof Metadata.Type,
  ) {
    const value = yield* encodeMetadata(data).pipe(Effect.mapError(unavailable));
    yield* secrets.set(key, new TextEncoder().encode(value)).pipe(Effect.mapError(unavailable));
  });
  const attach = Effect.fn("SharedGroupTransport.attach")(function* (
    session: PeerSession,
    grant: SharedGroupDeviceGrant,
  ) {
    const key = `${grant.groupKey}:${session.remoteDeviceId}`;
    const existing = connections.get(key);
    if (existing?.session === session) return existing;
    existing?.session.close();
    const connection: Connection = { session, grant, pending: new Map() };
    const running = new Map<string, Fiber.Fiber<void, never>>();
    connections.set(key, connection);
    const send = (frame: typeof Frame.Type) =>
      Effect.tryPromise({
        try: () => session.send("shared-group", new TextEncoder().encode(encodeFrame(frame))),
        catch: unavailable,
      });
    const unsubscribe = session.subscribe("shared-group", (bytes) => {
      let frame: typeof Frame.Type;
      try {
        if (bytes.length > 1_000_000) throw unavailable();
        frame = decodeFrame(new TextDecoder().decode(bytes));
        if (frame.id.length > 160) throw unavailable();
      } catch {
        session.close();
        return;
      }
      if (frame.type === "result" || frame.type === "error") {
        const deferred = connection.pending.get(frame.id);
        if (deferred)
          Effect.runForkWith(context)(
            frame.type === "result"
              ? Deferred.succeed(deferred, frame.result)
              : Deferred.fail(deferred, unavailable()),
          );
        return;
      }
      if (frame.type === "cancel") {
        const fiber = running.get(frame.id);
        if (fiber) Effect.runForkWith(context)(Fiber.interrupt(fiber));
        return;
      }
      if (running.size >= 16 || running.has(frame.id)) {
        session.close();
        return;
      }
      const operation = Effect.scoped(
        Effect.gen(function* () {
          const current = yield* authorize(grant.groupKey, session.remoteDeviceId);
          const result = yield* handler(current, frame.call);
          yield* authorize(grant.groupKey, session.remoteDeviceId);
          yield* send({ type: "result", id: frame.id, result });
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.code === "not-group-turn") yield* cleanup(grant, true).pipe(Effect.ignore);
            yield* send({ type: "error", id: frame.id }).pipe(Effect.ignore);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running.delete(frame.id);
          }),
        ),
        Effect.asVoid,
      );
      Effect.runForkWith(context)(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(operation, scope);
          running.set(frame.id, fiber);
        }),
      );
    });
    yield* Effect.promise(() => session.closed).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          unsubscribe();
          if (connections.get(key) === connection) {
            yield* cleanup(grant, false).pipe(Effect.ignore);
            connections.delete(key);
          }
          for (const deferred of connection.pending.values())
            yield* Deferred.fail(deferred, unavailable());
          for (const fiber of running.values()) yield* Fiber.interrupt(fiber);
        }),
      ),
      Effect.forkIn(scope),
    );
    return connection;
  });
  const unsubscribe = signaling.subscribeSharedGroupSessions((value) => {
    Effect.runForkWith(context)(attach(value.session, value.grant).pipe(Effect.ignore));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe();
      for (const connection of connections.values()) connection.session.close();
      connections.clear();
    }),
  );
  const getConnection = Effect.fn("SharedGroupTransport.getConnection")(function* (
    groupKey: string,
    deviceId: string,
  ) {
    const key = `${groupKey}:${deviceId}`;
    let lock = opening.get(key);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      opening.set(key, lock);
    }
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* authorize(groupKey, deviceId);
        const existing = connections.get(key);
        if (existing) return existing;
        if (connections.size >= 8) return yield* unavailable();
        const connectionScope = yield* Scope.make();
        yield* Scope.addFinalizer(scope, Scope.close(connectionScope, Exit.void));
        const opened = yield* signaling.connectSharedGroup(groupKey, deviceId).pipe(
          Effect.provideService(Scope.Scope, connectionScope),
          Effect.mapError(unavailable),
          Effect.onError(() => Scope.close(connectionScope, Exit.void)),
        );
        const connection = yield* attach(opened.session, opened.grant);
        yield* Effect.promise(() => opened.session.closed).pipe(
          Effect.andThen(Scope.close(connectionScope, Exit.void)),
          Effect.forkIn(scope),
        );
        return connection;
      }),
    );
  });
  const request = Effect.fn("SharedGroupTransport.request")(function* (
    groupKey: string,
    deviceId: string,
    call: SharedGroupPeerCall,
  ) {
    const connection = yield* getConnection(groupKey, deviceId);
    if (connection.pending.size >= 16) return yield* unavailable();
    const id = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const response = yield* Deferred.make<SharedGroupPeerResult, GroupChatError>();
    connection.pending.set(id, response);
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          connection.session.send(
            "shared-group",
            new TextEncoder().encode(encodeFrame({ type: "request", id, call })),
          ),
        catch: unavailable,
      });
      const result = yield* Deferred.await(response);
      yield* authorize(groupKey, deviceId);
      return result;
    }).pipe(
      Effect.tapError(() =>
        authorize(groupKey, deviceId).pipe(
          Effect.tapError((error) =>
            error.code === "not-group-turn" ? cleanup(connection.grant, true) : Effect.void,
          ),
          Effect.ignore,
        ),
      ),
      Effect.onInterrupt(() =>
        Effect.tryPromise({
          try: () =>
            connection.session.send(
              "shared-group",
              new TextEncoder().encode(encodeFrame({ type: "cancel", id })),
            ),
          catch: unavailable,
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          connection.pending.delete(id);
        }),
      ),
      Effect.timeoutOrElse({ duration: "5 minutes", orElse: () => Effect.fail(unavailable()) }),
    );
  });
  return SharedGroupTransport.of({
    register: (next, onDisconnect) => {
      handler = next;
      cleanup = onDisconnect;
      return () => {
        if (handler === next) {
          handler = () => Effect.fail(unavailable());
          cleanup = () => Effect.void;
        }
      };
    },
    request,
    authorize,
    selected: Effect.fn("SharedGroupTransport.selected")(function* (groupKey) {
      const { data } = yield* read();
      return data.selected
        .filter((item) => item.groupKey === groupKey)
        .map((item) => item.threadId);
    }),
    select: Effect.fn("SharedGroupTransport.select")(function* (groupKey, threadIds, selected) {
      yield* metadataLock.withPermit(
        Effect.gen(function* () {
          const { key, data } = yield* read();
          const others = data.selected.filter(
            (item) => item.groupKey !== groupKey || !threadIds.includes(item.threadId),
          );
          yield* write(key, {
            ...data,
            selected: selected
              ? [...others, ...threadIds.map((threadId) => ({ groupKey, threadId }))]
              : others,
          });
        }),
      );
    }),
    bindRoute: Effect.fn("SharedGroupTransport.bindRoute")(function* (groupKey, deviceId) {
      yield* authorize(groupKey, deviceId);
      yield* metadataLock.withPermit(
        Effect.gen(function* () {
          const { key, data } = yield* read();
          if (!data.routes.some((item) => item.groupKey === groupKey && item.deviceId === deviceId))
            yield* write(key, { ...data, routes: [...data.routes, { groupKey, deviceId }] });
        }),
      );
      return sharedGroupEnvironmentId(groupKey, deviceId);
    }),
    native: Effect.fn("SharedGroupTransport.native")(function* (id, input) {
      const { data } = yield* read();
      const route = data.routes.find(
        (item) => sharedGroupEnvironmentId(item.groupKey, item.deviceId) === id,
      );
      if (!route) return yield* unavailable();
      const requestWithoutPrivateContext =
        input.type === "dispatch"
          ? (({ catalogContextRevision: _revision, ...rest }) => rest)(input)
          : input;
      const result = yield* request(route.groupKey, route.deviceId, {
        type: "native",
        request: requestWithoutPrivateContext,
      });
      return yield* decodeNativeResponse(result).pipe(Effect.mapError(unavailable));
    }),
    disconnect: Effect.fn("SharedGroupTransport.disconnect")((groupKey) =>
      Effect.sync(() => {
        for (const [key, connection] of connections)
          if (key.startsWith(`${groupKey}:`)) connection.session.close();
      }),
    ),
  });
});
export const layer = Layer.effect(SharedGroupTransport, make);
