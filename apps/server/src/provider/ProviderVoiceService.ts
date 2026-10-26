import {
  CommandId,
  ProviderVoiceError,
  type ProviderVoiceCapabilitiesInput,
  type ProviderVoiceCapabilities,
  ProviderVoiceStartInput,
  type ProviderVoiceStartResult,
  type ProviderVoiceSessionInput,
  type ProviderVoiceEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as Live from "./LiveVoiceSessions.ts";

const activeStatuses = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const dictation = {
  supported: false as const,
  reason: "This Codex connection does not expose draft-only transcription.",
};
const encodeStartIdentity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      input: ProviderVoiceStartInput,
      account: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          email: Schema.optional(Schema.String),
          workspaceId: Schema.optional(Schema.String),
          profileId: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

export class ProviderVoiceService extends Context.Service<
  ProviderVoiceService,
  {
    readonly getCapabilities: (
      input: ProviderVoiceCapabilitiesInput,
    ) => Effect.Effect<ProviderVoiceCapabilities, ProviderVoiceError>;
    readonly start: (
      input: ProviderVoiceStartInput,
    ) => Effect.Effect<ProviderVoiceStartResult, ProviderVoiceError>;
    readonly subscribe: (
      input: ProviderVoiceSessionInput,
    ) => Stream.Stream<ProviderVoiceEvent, ProviderVoiceError>;
    readonly stop: (input: ProviderVoiceSessionInput) => Effect.Effect<void, ProviderVoiceError>;
  }
>()("mines/provider/ProviderVoiceService") {}

export const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const hub = yield* Live.LiveVoiceSessions;
  const crypto = yield* Crypto.Crypto;
  const subscribers = new Map<string, number>();
  const startLock = yield* Semaphore.make(1);
  const starts = new Map<
    string,
    { readonly fingerprint: string; readonly result: ProviderVoiceStartResult }
  >();
  const readThread = Effect.fn("ProviderVoiceService.readThread")(function* (
    input: ProviderVoiceCapabilitiesInput,
  ) {
    const thread = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "not-found" })));
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null)
      return yield* new ProviderVoiceError({ reason: "not-found" });
    return thread;
  });
  const getCapabilities = Effect.fn("ProviderVoiceService.getCapabilities")(function* (
    input: ProviderVoiceCapabilitiesInput,
  ) {
    const thread = yield* readThread(input);
    const selection = input.modelSelection ?? thread.modelSelection;
    const instance = yield* registry.getInstance(selection.instanceId);
    if (!instance || instance.driverKind !== "codex" || !instance.enabled)
      return {
        live: {
          supported: false,
          reason: "Select a connected Codex ChatGPT account to use Live voice.",
        },
        dictation,
      };
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (
      snapshot.auth.status !== "authenticated" ||
      snapshot.auth.type !== "chatgpt" ||
      snapshot.status !== "ready" ||
      snapshot.availability === "unavailable"
    )
      return {
        live: {
          supported: false,
          reason: "Live voice requires a connected Codex ChatGPT account.",
        },
        dictation,
      };
    if (snapshot.version === null || !parseSemver(snapshot.version))
      return {
        live: {
          supported: false,
          reason: "Could not verify this Codex version's Live voice support.",
        },
        dictation,
      };
    if (compareSemverVersions(snapshot.version, "0.164.0") < 0)
      return {
        live: { supported: false, reason: "Live voice requires Codex 0.164.0 or newer." },
        dictation,
      };
    return {
      live: { supported: true, reason: "Availability is checked by Codex when you start." },
      dictation,
    };
  });
  const sessionForRun = Effect.fn("ProviderVoiceService.sessionForRun")(function* (
    input: ProviderVoiceSessionInput,
  ) {
    yield* readThread(input);
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs"], { runIds: [input.runId] })
      .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "not-found" })));
    const run = records.runs.find(
      (entry) => entry.id === input.runId && entry.threadId === input.threadId,
    );
    if (!run?.liveVoice) return yield* new ProviderVoiceError({ reason: "not-found" });
    return { run, sessionId: run.liveVoice.sessionId, threadId: input.threadId };
  });
  const start = Effect.fn("ProviderVoiceService.start")((input: ProviderVoiceStartInput) =>
    startLock.withPermit(
      Effect.gen(function* () {
        const thread = yield* readThread(input);
        const selection = input.modelSelection ?? thread.modelSelection;
        const instance = yield* registry.getInstance(selection.instanceId);
        const auth = instance ? (yield* instance.snapshot.getSnapshot).auth : undefined;
        const identity = yield* encodeStartIdentity({
          input: { ...input, modelSelection: selection },
          account: auth && {
            type: auth.type,
            email: auth.email,
            workspaceId: auth.workspaceId,
            profileId: auth.profileId,
          },
        }).pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "invalid" })));
        const digest = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(identity))
          .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "unavailable" })));
        const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        );
        const previous = starts.get(input.commandId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            return yield* new ProviderVoiceError({ reason: "invalid" });
          return previous.result;
        }
        if (!(yield* getCapabilities(input)).live.supported)
          return yield* new ProviderVoiceError({ reason: "unsupported" });
        if (activeStatuses.has(thread.status))
          return yield* new ProviderVoiceError({ reason: "busy" });
        const sessionId = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "unavailable" })));
        const target = { sessionId, threadId: input.threadId };
        return yield* Effect.acquireUseRelease(
          hub.offer({ ...target, sdp: input.sdp }),
          () =>
            Effect.gen(function* () {
              const dispatched = yield* threads
                .dispatch({
                  type: "message.dispatch",
                  commandId: input.commandId,
                  threadId: input.threadId,
                  messageId: input.messageId,
                  modelSelection: selection,
                  text: "",
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  liveVoice: { sessionId },
                  createdBy: "user",
                  creationSource: "web",
                })
                .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "dispatch" })));
              const created = dispatched.storedEvents.find(
                (stored) => stored.event.type === "run.created",
              );
              if (
                created?.event.type !== "run.created" ||
                created.event.payload.threadId !== input.threadId ||
                created.event.payload.userMessageId !== input.messageId ||
                created.event.payload.liveVoice?.sessionId !== sessionId
              )
                return yield* new ProviderVoiceError({ reason: "dispatch" });
              const result = { runId: created.event.payload.id };
              starts.set(input.commandId, { fingerprint, result });
              if (starts.size > 64) starts.delete(starts.keys().next().value!);
              return result;
            }),
          (_, exit) =>
            Exit.isFailure(exit) ? hub.remove(target).pipe(Effect.ignore) : Effect.void,
        );
      }),
    ),
  );
  const stop = Effect.fn("ProviderVoiceService.stop")(function* (input: ProviderVoiceSessionInput) {
    const target = yield* sessionForRun(input);
    if (target.run.completedAt === null)
      yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`voice:stop:${input.runId}`),
          threadId: input.threadId,
          runId: input.runId,
          reason: "Live voice ended.",
          holdQueue: true,
        })
        .pipe(Effect.mapError(() => new ProviderVoiceError({ reason: "unavailable" })));
    yield* hub
      .cancelPending({ sessionId: target.sessionId, threadId: input.threadId })
      .pipe(Effect.ignore);
  });
  const subscribe = (input: ProviderVoiceSessionInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* sessionForRun(input);
        let terminal = false;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            subscribers.set(target.sessionId, (subscribers.get(target.sessionId) ?? 0) + 1),
          ),
          () =>
            Effect.suspend(() => {
              const remaining = (subscribers.get(target.sessionId) ?? 1) - 1;
              if (remaining > 0) {
                subscribers.set(target.sessionId, remaining);
                return Effect.void;
              }
              subscribers.delete(target.sessionId);
              return terminal ? Effect.void : stop(input).pipe(Effect.ignore);
            }),
        );
        return hub.subscribe(target).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "closed" || event.type === "error") terminal = true;
            }),
          ),
        );
      }),
    );
  return ProviderVoiceService.of({ getCapabilities, start, subscribe, stop });
});
export const layer = Layer.effect(ProviderVoiceService, make);
