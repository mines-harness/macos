import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Live from "./LiveVoiceSessions.ts";

it.effect("claims an offer once and binds it to its owning mine", () =>
  Effect.gen(function* () {
    const hub = yield* Live.make;
    const target = { sessionId: "session-1", threadId: ThreadId.make("mine-1") };
    yield* hub.offer({ ...target, sdp: "offer-sdp" });
    assert.strictEqual(
      (yield* hub.takeOffer({ ...target, threadId: ThreadId.make("mine-2") }).pipe(Effect.flip))
        .reason,
      "not-found",
    );
    assert.strictEqual(yield* hub.takeOffer(target), "offer-sdp");
    assert.strictEqual((yield* hub.takeOffer(target).pipe(Effect.flip)).reason, "not-found");
  }).pipe(Effect.scoped),
);

it.effect("replays the latest SDP before terminal state for late subscriptions", () =>
  Effect.gen(function* () {
    const hub = yield* Live.make;
    const target = { sessionId: "session-1", threadId: ThreadId.make("mine-1") };
    yield* hub.offer({ ...target, sdp: "offer" });
    yield* hub.publish({ ...target, event: { type: "started" } });
    yield* hub.publish({ ...target, event: { type: "sdp", sdp: "answer-old" } });
    yield* hub.publish({ ...target, event: { type: "sdp", sdp: "answer-new" } });
    yield* hub.publish({ ...target, event: { type: "closed" } });
    assert.deepStrictEqual(yield* Stream.runCollect(hub.subscribe(target)), [
      { type: "started" },
      { type: "sdp", sdp: "answer-new" },
      { type: "closed" },
    ]);
    assert.strictEqual(
      (yield* Stream.runCollect(
        hub.subscribe({ ...target, threadId: ThreadId.make("mine-2") }),
      ).pipe(Effect.flip)).reason,
      "not-found",
    );
  }).pipe(Effect.scoped),
);

it.effect("bounds live sessions and removes transient offers on cleanup", () =>
  Effect.gen(function* () {
    const hub = yield* Live.make;
    const threadId = ThreadId.make("mine-1");
    for (let index = 0; index < 32; index++)
      yield* hub.offer({ sessionId: `session-${index}`, threadId, sdp: "offer" });
    assert.strictEqual(
      (yield* hub.offer({ sessionId: "overflow", threadId, sdp: "offer" }).pipe(Effect.flip))
        .reason,
      "capacity",
    );
    yield* hub.remove({ sessionId: "session-0", threadId });
    yield* hub.offer({ sessionId: "replacement", threadId, sdp: "offer" });
    assert.strictEqual(
      (yield* hub.takeOffer({ sessionId: "session-0", threadId }).pipe(Effect.flip)).reason,
      "not-found",
    );
  }).pipe(Effect.scoped),
);
