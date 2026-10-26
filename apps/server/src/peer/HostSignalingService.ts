import { type SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import {
  signSharedGroupAccessProof,
  fetchSharedGroupAccess,
} from "@t3tools/shared/minesSharedGroupAccess";
import {
  PeerError,
  type PeerConfigure,
  type PeerConnectionState,
} from "@t3tools/contracts/minesPeer";
import {
  openPeerSignalGateway,
  getPeerAccount,
  registerPeerDevice,
  type DeviceSignalGateway,
} from "@t3tools/shared/minesPeerSignaling";
import {
  signPeerSignal,
  validateStunServers,
  verifyPeerSignal,
} from "@t3tools/shared/minesPeerTrust";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PeerHost from "./PeerHost.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import { bindPeerLoopback } from "./PeerLoopbackBridge.ts";
import { createNodePeer } from "./NodePeer.ts";
import { createPeerSessionRegistry } from "./PeerSessionRegistry.ts";

const StoredConfig = Schema.Struct({
  controlUrl: Schema.String,
  accountId: Schema.String,
  stunServers: Schema.Array(Schema.String),
});
type StoredConfig = typeof StoredConfig.Type;
const ConfigJson = Schema.fromJsonString(StoredConfig);
const decodeConfig = Schema.decodeEffect(ConfigJson);
const encodeConfig = Schema.encodeEffect(ConfigJson);
const isPeerError = Schema.is(PeerError);
const unavailable = () => new PeerError({ code: "direct-unavailable" });

export interface SharedGroupSession {
  readonly session: PeerSession;
  readonly grant: SharedGroupDeviceGrant;
}

export class HostSignalingService extends Context.Service<
  HostSignalingService,
  {
    readonly configure: (input: PeerConfigure) => Effect.Effect<void, PeerError>;
    readonly disable: Effect.Effect<void, PeerError>;
    readonly start: Effect.Effect<void, PeerError>;
    readonly state: SubscriptionRef.SubscriptionRef<PeerConnectionState>;
    readonly connect: (
      deviceId: string,
      options?: { readonly publishSession: boolean; readonly sharedGroupKey?: string },
    ) => Effect.Effect<PeerSession, PeerError, Scope.Scope>;
    readonly authorizeSharedGroup: (
      groupKey: string,
      remoteDeviceId: string,
    ) => Effect.Effect<SharedGroupDeviceGrant, PeerError>;
    readonly connectSharedGroup: (
      groupKey: string,
      remoteDeviceId: string,
    ) => Effect.Effect<SharedGroupSession, PeerError, Scope.Scope>;
    readonly subscribeSharedGroupSessions: (
      listener: (session: SharedGroupSession) => void,
    ) => () => void;
    readonly subscribeSessions: (listener: (session: PeerSession) => void) => () => void;
    readonly disconnectDevice: (deviceId: string) => Effect.Effect<void>;
  }
>()("mines/peer/HostSignalingService") {}

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const host = yield* PeerHost.PeerHost;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const server = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<PeerConnectionState>({
    configured: false,
    online: false,
    controlUrl: null,
    accountId: null,
    stunServers: [],
    failure: null,
  });
  let worker: Fiber.Fiber<void, never> | undefined;
  let gateway: DeviceSignalGateway | undefined;
  let current: StoredConfig | undefined;
  const context = yield* Effect.context<never>();
  const sessions = createPeerSessionRegistry();
  const sharedSessions = new Set<PeerSession>();
  const sharedListeners = new Set<(value: SharedGroupSession) => void>();
  const closeShared = () => {
    for (const session of sharedSessions) session.close();
    sharedSessions.clear();
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      sessions.close();
      closeShared();
    }),
  );
  const authorizeSharedGroup = Effect.fn("HostSignalingService.authorizeSharedGroup")(function* (
    groupKey: string,
    remoteDeviceId: string,
  ) {
    const config = current;
    if (!config) return yield* unavailable();
    const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
    const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const proof = signSharedGroupAccessProof(identity, {
      groupKey,
      toDeviceId: remoteDeviceId,
      issuedAt,
      nonce,
    });
    const grant = yield* Effect.tryPromise({
      try: (signal) => fetchSharedGroupAccess(config.controlUrl, proof, signal),
      catch: (error) => (isPeerError(error) ? error : unavailable()),
    }).pipe(
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(unavailable()) }),
    );
    if (
      current !== config ||
      grant.groupKey !== groupKey ||
      grant.from.deviceId !== identity.device.deviceId ||
      grant.from.publicKey !== identity.device.publicKey ||
      grant.to.deviceId !== remoteDeviceId ||
      (grant.coordinatorDevice.deviceId !== grant.from.deviceId &&
        grant.coordinatorDevice.deviceId !== grant.to.deviceId)
    )
      return yield* new PeerError({ code: "unapproved-device" });
    return grant;
  });

  const serve = Effect.fn("HostSignalingService.serve")(function* (config: StoredConfig) {
    const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
    const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const connection = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          openPeerSignalGateway({
            controlUrl: config.controlUrl,
            identity,
            randomId: () => nonce,
            nowSeconds: () => now,
            signal,
          }),
        catch: unavailable,
      }).pipe(
        Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unavailable()) }),
      ),
      (value) =>
        Effect.sync(() => {
          value.close();
          if (gateway === value) gateway = undefined;
        }),
    );
    gateway = connection;
    yield* SubscriptionRef.set(state, {
      configured: true,
      online: true,
      controlUrl: config.controlUrl,
      accountId: config.accountId,
      stunServers: config.stunServers,
      failure: null,
    });
    const incoming = yield* Effect.callback<never, PeerError>((resume) => {
      const unsubscribe = connection.subscribe((signal) => {
        if (signal.phase || signal.description.type !== "offer") return;
        const accept = Effect.scoped(
          Effect.gen(function* () {
            const sharedGrant =
              signal.sharedGroupKey === undefined
                ? undefined
                : yield* authorizeSharedGroup(signal.sharedGroupKey, signal.fromDeviceId);
            const accepted = yield* host.accept(signal, config.stunServers, sharedGrant?.to);
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                connection.subscribe((ready) => {
                  if (
                    ready.phase !== "ready" ||
                    ready.sessionId !== signal.sessionId ||
                    ready.fromDeviceId !== signal.fromDeviceId
                  )
                    return;
                  Effect.runForkWith(context)(
                    (signal.sharedGroupKey === undefined
                      ? Effect.void
                      : authorizeSharedGroup(signal.sharedGroupKey, signal.fromDeviceId)
                    ).pipe(Effect.andThen(accepted.acknowledge(ready)), Effect.ignore),
                  );
                }),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            yield* Effect.tryPromise({
              try: () => connection.send(accepted.answer),
              catch: unavailable,
            });
            const session = yield* accepted.session;
            if (current !== config) {
              session.close();
              return;
            }
            if (sharedGrant) {
              const grant = yield* authorizeSharedGroup(
                sharedGrant.groupKey,
                session.remoteDeviceId,
              );
              sharedSessions.add(session);
              for (const listener of sharedListeners) listener({ session, grant });
              yield* Effect.promise(() => session.closed);
              sharedSessions.delete(session);
              return;
            }
            sessions.publish(session);
            yield* Effect.acquireRelease(
              Effect.sync(() => bindPeerLoopback(session, server.port)),
              (close) => Effect.sync(close),
            );
            yield* Effect.promise(() => session.closed);
          }),
        ).pipe(Effect.ignore);
        Effect.runForkWith(context)(Effect.forkIn(accept, scope));
      });
      void connection.closed.then(() => resume(Effect.fail(unavailable())));
      return Effect.sync(unsubscribe);
    });
    return incoming;
  });
  const restart = Effect.fn("HostSignalingService.restart")(function* (
    config: StoredConfig | undefined,
  ) {
    current = config;
    if (worker) yield* Fiber.interrupt(worker);
    sessions.close();
    closeShared();
    for (const device of yield* trust.list.pipe(Effect.mapError(unavailable))) {
      yield* host.disconnectDevice(device.deviceId);
    }
    worker = undefined;
    gateway = undefined;
    yield* SubscriptionRef.set(state, {
      configured: config !== undefined,
      online: false,
      controlUrl: config?.controlUrl ?? null,
      accountId: config?.accountId ?? null,
      stunServers: config?.stunServers ?? [],
      failure: null,
    });
    if (!config) return;
    worker = yield* Effect.scoped(serve(config)).pipe(
      Effect.catch(() =>
        SubscriptionRef.set(state, {
          configured: true,
          online: false,
          controlUrl: config.controlUrl,
          accountId: config.accountId,
          stunServers: config.stunServers,
          failure: "direct-unavailable",
        }),
      ),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.asVoid,
      Effect.forkIn(scope),
    );
  });
  const start = Effect.gen(function* () {
    const saved = yield* secrets.get("mines-peer-control").pipe(Effect.mapError(unavailable));
    if (Option.isNone(saved)) return;
    const config = yield* decodeConfig(new TextDecoder().decode(saved.value)).pipe(
      Effect.mapError(unavailable),
    );
    yield* trust.selectAccount(config.accountId).pipe(Effect.mapError(unavailable));
    yield* restart(config);
  }).pipe(lock.withPermit);
  const connect = Effect.fn("HostSignalingService.connect")(
    function* (
      deviceId: string,
      options?: { readonly publishSession: boolean; readonly sharedGroupKey?: string },
    ) {
      const connection = gateway;
      const config = current;
      if (!connection || !config) return yield* unavailable();
      const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
      const sharedGrant =
        options?.sharedGroupKey === undefined
          ? undefined
          : yield* authorizeSharedGroup(options.sharedGroupKey, deviceId);
      const approved =
        sharedGrant?.to ??
        (yield* trust.list.pipe(Effect.mapError(unavailable))).find(
          (device) => device.deviceId === deviceId,
        );
      if (!approved) return yield* new PeerError({ code: "unapproved-device" });
      const sessionId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
      const endpoint = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            createNodePeer({
              remoteDeviceId: deviceId,
              initiator: true,
              stunServers: config.stunServers,
              ...(sharedGrant ? { allowedChannels: ["shared-group" as const] } : {}),
            }),
          catch: unavailable,
        }),
        (peer) => Effect.sync(peer.close),
      );
      const answer = yield* Deferred.make<void, PeerError>();
      yield* Effect.acquireRelease(
        Effect.sync(() => sessions.addEndpoint(deviceId, endpoint.close)),
        (remove) => Effect.sync(remove),
      );
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          connection.subscribe((signal) => {
            if (signal.sessionId !== sessionId || signal.fromDeviceId !== deviceId) return;
            const accepted = Effect.try({
              try: () => {
                const verified = verifyPeerSignal(signal, approved, identity.device.deviceId, now);
                if (
                  verified.sharedGroupKey !== options?.sharedGroupKey ||
                  verified.phase ||
                  verified.description.type !== "answer"
                )
                  throw unavailable();
                endpoint.acceptDescription(verified.description);
                return verified.description;
              },
              catch: unavailable,
            }).pipe(
              Effect.flatMap((description) =>
                Effect.tryPromise({
                  try: () =>
                    connection.send(
                      signPeerSignal(identity, {
                        sessionId,
                        toDeviceId: deviceId,
                        issuedAt: now,
                        description,
                        phase: "ready",
                        ...(sharedGrant ? { sharedGroupKey: sharedGrant.groupKey } : {}),
                      }),
                    ),
                  catch: unavailable,
                }),
              ),
              (effect) => Deferred.complete(answer, effect),
            );
            Effect.runForkWith(context)(accepted);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const description = yield* Effect.tryPromise({
        try: () => endpoint.description,
        catch: unavailable,
      });
      yield* Effect.tryPromise({
        try: () =>
          connection.send(
            signPeerSignal(identity, {
              sessionId,
              toDeviceId: deviceId,
              issuedAt: now,
              description,
              ...(sharedGrant ? { sharedGroupKey: sharedGrant.groupKey } : {}),
            }),
          ),
        catch: unavailable,
      });
      yield* Deferred.await(answer);
      const session = yield* Effect.tryPromise({
        try: () => endpoint.session,
        catch: unavailable,
      });
      const stillApproved = sharedGrant
        ? (yield* authorizeSharedGroup(sharedGrant.groupKey, deviceId)).to.publicKey ===
          approved.publicKey
        : (yield* trust.list.pipe(Effect.mapError(unavailable))).some(
            (device) => device.deviceId === deviceId && device.publicKey === approved.publicKey,
          );
      if (current !== config || !stillApproved) {
        session.close();
        return yield* new PeerError({ code: "unapproved-device" });
      }
      if (sharedGrant) sharedSessions.add(session);
      else if (options?.publishSession !== false) sessions.publish(session);
      return session;
    },
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(unavailable()) }),
  );
  return HostSignalingService.of({
    state,
    start,
    subscribeSessions: sessions.subscribe,
    disconnectDevice: Effect.fn("HostSignalingService.disconnectDevice")((id) =>
      Effect.sync(() => sessions.disconnectDevice(id)),
    ),
    configure: Effect.fn("HostSignalingService.configure")(function* (input) {
      const stunServers = yield* Effect.try({
        try: () => validateStunServers(input.stunServers),
        catch: unavailable,
      });
      const accountId = yield* Effect.tryPromise({
        try: () =>
          getPeerAccount({
            controlUrl: input.controlUrl,
            bearerToken: async () => input.bearerToken,
          }),
        catch: unavailable,
      });
      yield* restart(undefined);
      yield* secrets.remove("mines-peer-control").pipe(Effect.mapError(unavailable));
      yield* trust.selectAccount(accountId).pipe(Effect.mapError(unavailable));
      const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
      const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const registeredAccountId = yield* Effect.tryPromise({
        try: () =>
          registerPeerDevice({
            controlUrl: input.controlUrl,
            identity,
            randomId: () => nonce,
            nowSeconds: () => now,
            bearerToken: async () => input.bearerToken,
          }),
        catch: unavailable,
      });
      if (registeredAccountId !== accountId) return yield* unavailable();
      const config = { controlUrl: input.controlUrl, accountId, stunServers };
      const saved = yield* encodeConfig(config).pipe(Effect.mapError(unavailable));
      yield* secrets
        .set("mines-peer-control", new TextEncoder().encode(saved))
        .pipe(Effect.mapError(unavailable));
      yield* restart(config);
    }, lock.withPermit),
    disable: lock.withPermit(
      Effect.gen(function* () {
        yield* secrets.remove("mines-peer-control").pipe(Effect.mapError(unavailable));
        yield* restart(undefined);
        yield* trust.selectAccount(null).pipe(Effect.mapError(unavailable));
      }),
    ),
    connect,
    authorizeSharedGroup,
    connectSharedGroup: Effect.fn("HostSignalingService.connectSharedGroup")(
      function* (groupKey, deviceId) {
        const session = yield* connect(deviceId, {
          publishSession: false,
          sharedGroupKey: groupKey,
        });
        const grant = yield* authorizeSharedGroup(groupKey, deviceId);
        return { session, grant };
      },
    ),
    subscribeSharedGroupSessions: (listener) => {
      sharedListeners.add(listener);
      return () => {
        sharedListeners.delete(listener);
      };
    },
  });
});

export const layer = Layer.effect(HostSignalingService, make);
