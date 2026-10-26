import { PeerError, type PeerDevice, type PeerSignal } from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import { signPeerSignal, verifyPeerSignal } from "@t3tools/shared/minesPeerTrust";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { createNodePeer } from "./NodePeer.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";

export class PeerHost extends Context.Service<
  PeerHost,
  {
    readonly accept: (
      signal: PeerSignal,
      stunServers: ReadonlyArray<string>,
      sharedDevice?: PeerDevice,
    ) => Effect.Effect<
      {
        readonly answer: PeerSignal;
        readonly acknowledge: (signal: PeerSignal) => Effect.Effect<void, PeerError>;
        readonly session: Effect.Effect<PeerSession, PeerError>;
      },
      PeerError,
      Scope.Scope
    >;
    readonly disconnectDevice: (deviceId: string) => Effect.Effect<void>;
  }
>()("mines/peer/PeerHost") {}

const make = Effect.gen(function* () {
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const pending = new Map<string, number>();
  const sessions = new Map<string, Set<() => void>>();
  const accept = Effect.fn("PeerHost.accept")(function* (
    signal: PeerSignal,
    stunServers: ReadonlyArray<string>,
    sharedDevice?: PeerDevice,
  ) {
    if ((signal.sharedGroupKey !== undefined) !== (sharedDevice !== undefined))
      return yield* new PeerError({ code: "unapproved-device" });
    const identity = yield* trust.identity.pipe(
      Effect.mapError(() => new PeerError({ code: "unapproved-device" })),
    );
    const devices = sharedDevice
      ? [sharedDevice]
      : yield* trust.list.pipe(Effect.mapError(() => new PeerError({ code: "unapproved-device" })));
    const approved = devices.find((device) => device.deviceId === signal.fromDeviceId);
    if (!approved || signal.phase || signal.description.type !== "offer")
      return yield* new PeerError({ code: "unapproved-device" });
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    yield* Effect.try({
      try: () => verifyPeerSignal(signal, approved, identity.device.deviceId, now),
      catch: () => new PeerError({ code: "invalid-signature" }),
    });
    for (const [key, expiresAt] of pending) if (expiresAt < now) pending.delete(key);
    const key = `${signal.fromDeviceId}:${signal.sessionId}`;
    if (pending.has(key) || pending.size >= 256)
      return yield* new PeerError({ code: "replayed-signal" });
    pending.set(key, signal.expiresAt);
    if ([...sessions.values()].reduce((sum, value) => sum + value.size, 0) >= 8)
      return yield* new PeerError({ code: "direct-unavailable" });
    const endpoint = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          createNodePeer({
            remoteDeviceId: signal.fromDeviceId,
            initiator: false,
            stunServers,
            ...(sharedDevice ? { allowedChannels: ["shared-group" as const] } : {}),
          }),
        catch: () => new PeerError({ code: "direct-unavailable" }),
      }),
      (peer) =>
        Effect.sync(() => {
          peer.close();
          const active = sessions.get(signal.fromDeviceId);
          active?.delete(peer.close);
          if (active?.size === 0) sessions.delete(signal.fromDeviceId);
        }),
    );
    const active = sessions.get(signal.fromDeviceId) ?? new Set();
    active.add(endpoint.close);
    sessions.set(signal.fromDeviceId, active);
    yield* Effect.try({
      try: () => endpoint.acceptDescription(signal.description),
      catch: () => new PeerError({ code: "invalid-description" }),
    });
    const description = yield* Effect.tryPromise({
      try: () => endpoint.description,
      catch: () => new PeerError({ code: "direct-unavailable" }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new PeerError({ code: "direct-unavailable" })),
      }),
    );
    const answer = signPeerSignal(identity, {
      sessionId: signal.sessionId,
      toDeviceId: signal.fromDeviceId,
      issuedAt: Math.floor((yield* Clock.currentTimeMillis) / 1000),
      description,
      ...(signal.sharedGroupKey ? { sharedGroupKey: signal.sharedGroupKey } : {}),
    });
    return {
      answer,
      acknowledge: Effect.fn("PeerHost.acknowledge")(function* (ready: PeerSignal) {
        const receivedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        yield* Effect.try({
          try: () => {
            const verified = verifyPeerSignal(
              ready,
              approved,
              identity.device.deviceId,
              receivedAt,
            );
            if (
              verified.phase !== "ready" ||
              verified.sharedGroupKey !== signal.sharedGroupKey ||
              verified.sessionId !== signal.sessionId ||
              verified.description.type !== "answer" ||
              verified.description.sdp !== answer.description.sdp
            )
              throw new PeerError({ code: "invalid-description" });
            endpoint.activateCandidates();
          },
          catch: () => new PeerError({ code: "invalid-signature" }),
        });
      }),
      session: Effect.tryPromise({
        try: () => endpoint.session,
        catch: () => new PeerError({ code: "direct-unavailable" }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(new PeerError({ code: "direct-unavailable" })),
        }),
      ),
    };
  });
  return PeerHost.of({
    accept,
    disconnectDevice: Effect.fn("PeerHost.disconnectDevice")((deviceId: string) =>
      Effect.sync(() => {
        for (const close of sessions.get(deviceId) ?? []) close();
        sessions.delete(deviceId);
      }),
    ),
  });
});

export const layer = Layer.effect(PeerHost, make);
