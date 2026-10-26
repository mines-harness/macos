import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Client from "./client.ts";
import * as Replay from "./replay.ts";
import * as Realtime from "./realtime.ts";

it.effect("starts WebRTC audio and stops only the requested native threads", () =>
  Effect.gen(function* () {
    const transcript: Replay.CodexAppServerReplayTranscript = {
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.164.0",
      scenario: "live-voice-routing",
      entries: [
        {
          type: "expect_outbound",
          frame: {
            id: 1,
            method: "thread/realtime/start",
            params: {
              threadId: "thread-a",
              outputModality: "audio",
              transport: { type: "webrtc", sdp: "offer-a" },
            },
          },
        },
        { type: "emit_inbound", frame: { id: 1, result: {} } },
        {
          type: "expect_outbound",
          frame: { id: 2, method: "thread/realtime/stop", params: { threadId: "thread-b" } },
        },
        { type: "emit_inbound", frame: { id: 2, result: {} } },
      ],
    };
    const driver = yield* Replay.makeReplayDriver(transcript);
    yield* Effect.gen(function* () {
      const client = yield* Client.CodexAppServerClient;
      yield* Realtime.start(client, { threadId: "thread-a", sdp: "offer-a" });
      yield* Realtime.stop(client, { threadId: "thread-b" });
      assert.strictEqual((yield* Ref.get(driver.state)).cursor, transcript.entries.length);
    }).pipe(Effect.provide(Replay.layerReplayWithDriver(driver)));
  }).pipe(Effect.scoped),
);

it.effect("preserves an unsupported native realtime rejection without a fallback", () =>
  Effect.gen(function* () {
    const client = yield* Client.CodexAppServerClient;
    const failure = yield* Realtime.start(client, { threadId: "thread-a", sdp: "offer" }).pipe(
      Effect.flip,
    );
    assert.strictEqual(failure._tag, "CodexAppServerRequestError");
    if (failure._tag === "CodexAppServerRequestError") {
      assert.strictEqual(failure.code, -32601);
      assert.strictEqual(failure.method, "thread/realtime/start");
      assert.strictEqual(failure.message, "Realtime is not available for this account");
    }
  }).pipe(
    Effect.provide(
      Replay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "0.164.0",
        scenario: "unsupported-live-voice",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              id: 1,
              method: "thread/realtime/start",
              params: {
                threadId: "thread-a",
                outputModality: "audio",
                transport: { type: "webrtc", sdp: "offer" },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 1,
              error: { code: -32601, message: "Realtime is not available for this account" },
            },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);
