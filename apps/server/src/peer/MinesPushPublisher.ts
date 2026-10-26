import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import {
  MinesPushError,
  sendMinesPushRequest,
  signMinesPushRequest,
  type MinesPushKind,
} from "@t3tools/shared/minesPush";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as HostSignalingService from "./HostSignalingService.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";

export function genericPushEvent(
  event: OrchestrationV2DomainEvent,
): { localKey: string; kind: MinesPushKind } | null {
  if (
    event.type === "run.updated" &&
    (event.payload.status === "completed" || event.payload.status === "failed")
  )
    return {
      localKey: `run:${event.payload.id}:${event.payload.status}`,
      kind: event.payload.status === "completed" ? "run-completed" : "needs-attention",
    };
  if (event.type === "runtime-request.updated" && event.payload.status === "pending")
    return { localKey: `request:${event.payload.id}`, kind: "needs-attention" };
  return null;
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Environment).MINES_PUSH_ENABLED !== "1") return;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const signaling = yield* HostSignalingService.HostSignalingService;
    const trust = yield* PeerTrustStore.PeerTrustStore;
    const crypto = yield* Crypto.Crypto;
    const queue = yield* Queue.dropping<{
      kind: MinesPushKind;
      accountId: string;
      deviceId: string;
    }>(64);
    const seen = new Map<string, number>();
    yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        const generic = genericPushEvent(event);
        if (!generic) return;
        const now = yield* Clock.currentTimeMillis;
        for (const [key, at] of seen) if (at < now - 3_600_000) seen.delete(key);
        if (seen.has(generic.localKey)) return;
        if (seen.size >= 512) seen.delete(seen.keys().next().value!);
        seen.set(generic.localKey, now);
        const state = yield* SubscriptionRef.get(signaling.state);
        if (!state.configured || !state.accountId) return;
        const identity = yield* trust.identity;
        yield* Queue.offer(queue, {
          kind: generic.kind,
          accountId: state.accountId,
          deviceId: identity.device.deviceId,
        });
      }).pipe(Effect.ignore),
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(queue);
        const state = yield* SubscriptionRef.get(signaling.state);
        if (!state.configured || !state.controlUrl || state.accountId !== job.accountId) return;
        const identity = yield* trust.identity;
        if (identity.device.deviceId !== job.deviceId) return;
        const eventId = yield* crypto.randomUUIDv4();
        const nonce = yield* crypto.randomUUIDv4();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const request = signMinesPushRequest(
          identity,
          { action: "alert", eventId, kind: job.kind },
          nonce,
          now,
        );
        yield* Effect.tryPromise({
          try: () => sendMinesPushRequest({ controlUrl: state.controlUrl!, request }),
          catch: () => new MinesPushError({ code: "unavailable" }),
        });
      }).pipe(Effect.catch(() => Effect.logDebug("mines generic notification unavailable"))),
    ).pipe(Effect.forkScoped);
  }),
);
