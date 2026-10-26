import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2AppThread,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as Live from "./LiveVoiceSessions.ts";
import * as Voice from "./ProviderVoiceService.ts";

const threadId = ThreadId.make("voice-mine");
const selection = { instanceId: ProviderInstanceId.make("codex-personal"), model: "gpt-6.1-sol" };
const input = {
  threadId,
  commandId: CommandId.make("voice-start"),
  messageId: MessageId.make("voice-message"),
  sdp: "private-offer",
  modelSelection: selection,
};
const makeHarness = Effect.fn("ProviderVoiceTest.makeHarness")(function* (
  options: {
    authType?: string;
    version?: string | null;
    mismatch?: boolean;
    reject?: "typed" | "defect";
  } = {},
) {
  let status: "idle" | "running" = "idle";
  const commands: OrchestrationV2ServerCommand[] = [];
  const offers: { sessionId: string; threadId: ThreadId }[] = [];
  const runs: OrchestrationV2Run[] = [];
  const hub = yield* Live.make;
  const captureHub = {
    ...hub,
    offer: (offer: Parameters<typeof hub.offer>[0]) => {
      offers.push(offer);
      return hub.offer(offer);
    },
  };
  const shell = () => ({
    ...v2PullRequestThread({
      id: threadId,
      projectId: ProjectId.make("voice-project"),
      title: "Voice",
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestUserMessageAt: null,
      createdAt: "2026-10-26T00:00:00Z",
      updatedAt: "2026-10-26T00:00:00Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
    }),
    status,
  });
  const getThreadRecords: Threads.ThreadManagementService["Service"]["getThreadRecords"] = ((
    _threadId: ThreadId,
  ) =>
    Effect.succeed({
      thread: shell() as unknown as OrchestrationV2AppThread,
      runs,
    })) as Threads.ThreadManagementService["Service"]["getThreadRecords"];
  const dispatch: Threads.ThreadManagementService["Service"]["dispatch"] = (command) =>
    Effect.gen(function* () {
      commands.push(command);
      if (options.reject === "typed")
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
        });
      if (options.reject === "defect") return yield* Effect.die("dispatch defect");
      if (command.type !== "message.dispatch")
        return { sequence: commands.length, storedEvents: [] };
      status = "running";
      const run = {
        id: RunId.make(`voice-run-${runs.length}`),
        threadId: command.threadId,
        userMessageId: command.messageId,
        completedAt: null,
        liveVoice: options.mismatch ? undefined : command.liveVoice,
      } as OrchestrationV2Run;
      runs.push(run);
      return {
        sequence: commands.length,
        storedEvents: [{ event: { type: "run.created", payload: run } }],
      } as unknown as Effect.Success<ReturnType<typeof dispatch>>;
    });
  const snapshot = {
    auth: {
      status: "authenticated",
      type: options.authType ?? "chatgpt",
      email: "person@example.test",
    },
    version: options.version === undefined ? "0.164.0" : options.version,
    enabled: true,
    installed: true,
    status: "ready",
  } as ServerProvider;
  const instance = {
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed(snapshot) },
  } as unknown as ProviderInstance;
  const voice = yield* Voice.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.sync(shell),
          getThreadRecords,
          dispatch,
        }),
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(instance),
        }),
        Layer.succeed(Live.LiveVoiceSessions, captureHub),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
            digest: (_algorithm, data) =>
              Effect.promise(
                async () =>
                  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))),
              ),
          }),
        ),
      ),
    ),
  );
  return { voice, hub, commands, offers, runs, snapshot };
});

it.effect.each(["apiKey", "amazonBedrock", "unknown"])(
  "rejects %s accounts even for a Codex model",
  (authType) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ authType });
      assert.strictEqual(
        (yield* harness.voice.getCapabilities({ threadId })).live.supported,
        false,
      );
      assert.strictEqual(
        (yield* harness.voice.start(input).pipe(Effect.flip)).reason,
        "unsupported",
      );
      assert.strictEqual(harness.commands.length, 0);
      assert.strictEqual(harness.offers.length, 0);
    }).pipe(Effect.scoped),
);

it.effect.each([null, "0.159.0"])("does not claim voice support for native version %s", (version) =>
  Effect.gen(function* () {
    const { voice } = yield* makeHarness({ version });
    assert.strictEqual((yield* voice.getCapabilities({ threadId })).live.supported, false);
  }).pipe(Effect.scoped),
);

it.effect("deduplicates simultaneous command retries and rejects changed command identity", () =>
  Effect.gen(function* () {
    const { voice, commands, offers } = yield* makeHarness();
    const results = yield* Effect.all([voice.start(input), voice.start(input)], { concurrency: 2 });
    assert.deepStrictEqual(results[0], results[1]);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(offers.length, 1);
    assert.strictEqual(
      (yield* voice.start({ ...input, sdp: "different-offer" }).pipe(Effect.flip)).reason,
      "invalid",
    );
    assert.strictEqual(
      (yield* voice
        .start({ ...input, modelSelection: { ...selection, model: "different-model" } })
        .pipe(Effect.flip)).reason,
      "invalid",
    );
    assert.strictEqual(JSON.stringify(commands).includes("private-offer"), false);
  }).pipe(Effect.scoped),
);

it.effect("serializes competing starts and dispatches only one voice run", () =>
  Effect.gen(function* () {
    const { voice, commands } = yield* makeHarness();
    const results = yield* Effect.all(
      [
        voice.start(input).pipe(Effect.result),
        voice
          .start({
            ...input,
            commandId: CommandId.make("second-start"),
            messageId: MessageId.make("second-message"),
          })
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
    assert.strictEqual(commands.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("rejects unrelated replay results and removes the unused SDP offer", () =>
  Effect.gen(function* () {
    const { voice, offers, hub } = yield* makeHarness({ mismatch: true });
    assert.strictEqual((yield* voice.start(input).pipe(Effect.flip)).reason, "dispatch");
    assert.strictEqual((yield* hub.takeOffer(offers[0]!).pipe(Effect.flip)).reason, "not-found");
  }).pipe(Effect.scoped),
);

it.effect.each(["typed", "defect"] as const)(
  "removes the SDP offer after a %s dispatch failure",
  (reject) =>
    Effect.gen(function* () {
      const { voice, offers, hub } = yield* makeHarness({ reject });
      assert.strictEqual(Exit.isFailure(yield* voice.start(input).pipe(Effect.exit)), true);
      assert.strictEqual((yield* hub.takeOffer(offers[0]!).pipe(Effect.flip)).reason, "not-found");
    }).pipe(Effect.scoped),
);

it.effect("closes a committed run stopped before the adapter claims its offer", () =>
  Effect.gen(function* () {
    const { voice, offers, hub } = yield* makeHarness();
    const { runId } = yield* voice.start(input);
    yield* voice.stop({ threadId, runId });
    assert.strictEqual((yield* hub.takeOffer(offers[0]!).pipe(Effect.flip)).reason, "not-found");
    assert.deepStrictEqual(yield* Stream.runCollect(voice.subscribe({ threadId, runId })), [
      { type: "closed" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("routes stop through the run and rejects another mine's association", () =>
  Effect.gen(function* () {
    const { voice, commands, offers, hub } = yield* makeHarness();
    const { runId } = yield* voice.start(input);
    yield* hub.takeOffer(offers[0]!);
    assert.strictEqual(
      (yield* voice.stop({ threadId: ThreadId.make("other-mine"), runId }).pipe(Effect.flip))
        .reason,
      "not-found",
    );
    yield* hub.publish({ ...offers[0]!, event: { type: "sdp", sdp: "answer" } });
    yield* voice.subscribe({ threadId, runId }).pipe(Stream.take(1), Stream.runCollect);
    assert.strictEqual(commands.at(-1)?.type, "run.interrupt");
    const terminal = yield* Stream.runCollect(hub.subscribe(offers[0]!).pipe(Stream.take(1)));
    assert.deepStrictEqual(terminal, [{ type: "sdp", sdp: "answer" }]);
  }).pipe(Effect.scoped),
);

it.effect("does not interrupt a naturally closed voice session", () =>
  Effect.gen(function* () {
    const { voice, commands, offers, hub } = yield* makeHarness();
    const { runId } = yield* voice.start(input);
    yield* hub.takeOffer(offers[0]!);
    yield* hub.publish({ ...offers[0]!, event: { type: "closed" } });
    yield* Stream.runCollect(voice.subscribe({ threadId, runId }));
    assert.strictEqual(commands.length, 1);
  }).pipe(Effect.scoped),
);
