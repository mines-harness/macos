import {
  ProviderVoiceError,
  ProviderVoiceEvent,
  ProviderVoiceSdp,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

type Target = { readonly sessionId: string; readonly threadId: ThreadId };
const decodeSdp = Schema.decodeEffect(ProviderVoiceSdp);
const decodeEvent = Schema.decodeEffect(ProviderVoiceEvent);
export class LiveVoiceSessions extends Context.Service<
  LiveVoiceSessions,
  {
    readonly offer: (
      input: Target & { readonly sdp: string },
    ) => Effect.Effect<void, ProviderVoiceError>;
    readonly takeOffer: (input: Target) => Effect.Effect<string, ProviderVoiceError>;
    readonly publish: (
      input: Target & { readonly event: ProviderVoiceEvent },
    ) => Effect.Effect<void, ProviderVoiceError>;
    readonly subscribe: (input: Target) => Stream.Stream<ProviderVoiceEvent, ProviderVoiceError>;
    readonly remove: (input: Target) => Effect.Effect<void, ProviderVoiceError>;
    readonly cancelPending: (input: Target) => Effect.Effect<void, ProviderVoiceError>;
  }
>()("mines/provider/LiveVoiceSessions") {}

interface Session {
  readonly threadId: ThreadId;
  readonly events: PubSub.PubSub<ProviderVoiceEvent>;
  offer: string | null;
  started: boolean;
  sdp: Extract<ProviderVoiceEvent, { type: "sdp" }> | null;
  terminal: Extract<ProviderVoiceEvent, { type: "closed" | "error" }> | null;
}

export const make = Effect.gen(function* () {
  const sessions = new Map<string, Session>();
  const lock = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions.values(),
      (session) => {
        session.offer = null;
        session.sdp = null;
        return PubSub.shutdown(session.events);
      },
      { discard: true },
    ).pipe(Effect.andThen(Effect.sync(() => sessions.clear()))),
  );
  const lookup = Effect.fn("LiveVoiceSessions.lookup")(function* (target: Target) {
    const session = sessions.get(target.sessionId);
    if (!session || session.threadId !== target.threadId)
      return yield* new ProviderVoiceError({ reason: "not-found" });
    return session;
  });
  const offer = Effect.fn("LiveVoiceSessions.offer")(function* (
    input: Target & { readonly sdp: string },
  ) {
    const sdp = yield* decodeSdp(input.sdp).pipe(
      Effect.mapError(() => new ProviderVoiceError({ reason: "invalid" })),
    );
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (sessions.has(input.sessionId)) return yield* new ProviderVoiceError({ reason: "busy" });
        if (sessions.size >= 32) {
          const finished = [...sessions].find(([, session]) => session.terminal !== null);
          if (!finished) return yield* new ProviderVoiceError({ reason: "capacity" });
          sessions.delete(finished[0]);
          yield* PubSub.shutdown(finished[1].events);
        }
        sessions.set(input.sessionId, {
          threadId: input.threadId,
          offer: sdp,
          events: yield* PubSub.sliding<ProviderVoiceEvent>(64),
          started: false,
          sdp: null,
          terminal: null,
        });
      }),
    );
  });
  const takeOffer = Effect.fn("LiveVoiceSessions.takeOffer")(function* (input: Target) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const session = yield* lookup(input);
        if (session.offer === null || session.terminal)
          return yield* new ProviderVoiceError({ reason: "not-found" });
        const sdp = session.offer;
        session.offer = null;
        return sdp;
      }),
    );
  });
  const publish = Effect.fn("LiveVoiceSessions.publish")(function* (
    input: Target & { readonly event: ProviderVoiceEvent },
  ) {
    const event = yield* decodeEvent(input.event).pipe(
      Effect.mapError(() => new ProviderVoiceError({ reason: "invalid" })),
    );
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const session = yield* lookup(input);
        if (session.terminal) return;
        if (event.type === "started") session.started = true;
        if (event.type === "sdp") session.sdp = event;
        if (event.type === "closed" || event.type === "error") {
          session.terminal = event;
          session.offer = null;
          yield* PubSub.end(session.events, event);
        } else yield* PubSub.publish(session.events, event);
      }),
    );
  });
  const subscribe = (input: Target) =>
    Stream.unwrap(
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* lookup(input);
          const initial: ProviderVoiceEvent[] = [
            ...(session.started ? [{ type: "started" as const }] : []),
            ...(session.sdp ? [session.sdp] : []),
          ];
          if (session.terminal) return Stream.fromIterable([...initial, session.terminal]);
          const subscription = yield* PubSub.subscribe(session.events);
          return Stream.concat(
            Stream.fromIterable(initial),
            Stream.fromSubscription(subscription),
          ).pipe(Stream.takeUntil((event) => event.type === "closed" || event.type === "error"));
        }),
      ),
    );
  const remove = Effect.fn("LiveVoiceSessions.remove")(function* (input: Target) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        if (!sessions.has(input.sessionId)) return;
        const session = yield* lookup(input);
        sessions.delete(input.sessionId);
        session.offer = null;
        session.sdp = null;
        yield* PubSub.end(session.events, { type: "closed" });
      }),
    );
  });
  const cancelPending = Effect.fn("LiveVoiceSessions.cancelPending")(function* (input: Target) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const session = yield* lookup(input);
        if (session.offer === null || session.terminal) return;
        session.offer = null;
        session.terminal = { type: "closed" };
        yield* PubSub.end(session.events, session.terminal);
      }),
    );
  });
  return LiveVoiceSessions.of({ offer, takeOffer, publish, subscribe, remove, cancelPending });
});
export const layer = Layer.effect(LiveVoiceSessions, make);
