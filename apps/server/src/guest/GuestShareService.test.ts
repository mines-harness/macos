import * as DocumentText from "../provider/DocumentText.ts";
import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestShareId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GuestPublicEndpoint from "./GuestPublicEndpoint.ts";
import * as GuestShareService from "./GuestShareService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
const hostname = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const publicRoute = Ref.makeUnsafe<string | null>(null);
const publicEndpoint = Effect.map(Ref.get(publicRoute), (host) =>
  host === null
    ? null
    : {
        host,
        url: (credential: string) => `https://mines.test/guest?host=${host}#${credential}`,
      },
);
const layerPublicEndpoint = Layer.mock(GuestPublicEndpoint.GuestPublicEndpoint)({
  current: publicEndpoint,
  ensure: publicEndpoint.pipe(
    Effect.filterOrFail(
      Predicate.isNotNull,
      () => new GuestPublicEndpoint.GuestPublicEndpointError({ stage: "connection" }),
    ),
  ),
});
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-share-" });
// The real cleanup also closes terminals and previews; these tests only need the files gone.
const layerCleanup = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: (attachmentIds) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
            return path === null ? Effect.void : fileSystem.remove(path).pipe(Effect.orDie);
          },
          { discard: true },
        ),
    };
  }),
).pipe(Layer.provide(layerConfig), Layer.provide(NodeServices.layer));
const layerTest = GuestShareService.layer.pipe(
  Layer.provideMerge(
    CommandOutputHub.layer.pipe(
      Layer.provideMerge(layerOrchestration.pipe(Layer.provide(layerCleanup))),
    ),
  ),
  Layer.provide(
    Layer.unwrap(
      Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) => orchestrator.dispatch(command),
          getThreadSnapshotWindow: (id, options) =>
            orchestrator.getThreadSnapshotWindow(id, options),
        }),
      ),
    ).pipe(Layer.provide(layerOrchestration.pipe(Layer.provide(layerCleanup)))),
  ),
  Layer.provide(layerProviders),
  Layer.provideMerge(ServerSettings.layerTest({ guestSharingEnabled: true })),
  Layer.provide(layerConnect),
  Layer.provide(layerPublicEndpoint),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);

const threadId = ThreadId.make("thread:guest-share-service");

const shareThreadFor = Effect.fn(function* (threadId: ThreadId) {
  yield* Ref.set(hostname, "env.t3.test");
  yield* Ref.set(publicRoute, null);
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:guest-share-service"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const raw = yield* GuestShareService.GuestShareService;
  const guestShares = {
    ...raw,
    redeem: (request: Parameters<typeof raw.redeem>[0], ip = "203.0.113.1") =>
      raw.redeem(request, ip),
    check: (session: string, ip = "203.0.113.1") => raw.check(session, ip),
    submit: (
      session: string,
      request: Parameters<typeof raw.submit>[1],
      uploads: Parameters<typeof raw.submit>[2],
      ip = "203.0.113.1",
    ) => raw.submit(session, request, uploads, ip),
    stream: (session: string, ip = "203.0.113.1") => raw.stream(session, ip),
    render: (session: string, item: string, ip = "203.0.113.1") => raw.render(session, item, ip),
    item: (session: string, item: string, ip = "203.0.113.1") => raw.item(session, item, ip),
    commandOutput: (session: string, item: string, ip = "203.0.113.1") =>
      raw.commandOutput(session, item, ip),
    attachment: (session: string, item: string, ip = "203.0.113.1") =>
      raw.attachment(session, item, ip),
  };
  const { url } = yield* guestShares.create({ threadId, permission: "confirm" });
  assert.isTrue(url.startsWith("https://env.t3.test/guest#"));
  const credential = url.slice(url.indexOf("#") + 1);
  return { orchestrator, guestShares, credential };
});
const shareThread = shareThreadFor(threadId);

it.effect("uses the public endpoint without a tunnel while retaining existing managed links", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const managedGuest = yield* guestShares.redeem({ credential, name: "Before" });
    yield* Ref.set(publicRoute, "device-route");
    yield* guestShares.check(managedGuest.token);
    yield* Ref.set(hostname, null);
    const { url, share } = yield* guestShares.create({ threadId });
    assert.isTrue(url.startsWith("https://mines.test/guest?host=device-route#"));
    assert.equal(share.host, "device-route");
    const guest = yield* guestShares.redeem({ credential: url.split("#")[1]!, name: "Public" });
    yield* guestShares.check(guest.token);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("creates viewer links for six hours by default", () =>
  Effect.gen(function* () {
    const { guestShares } = yield* shareThread;
    const { share } = yield* guestShares.create({ threadId });
    assert.equal(share.permission, "viewer");
    assert.equal(share.maxGuests, 1);
    assert.equal(Date.parse(share.expiresAt) - Date.parse(share.createdAt), 6 * 60 * 60 * 1000);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a guest identity across network changes and bans its latest request IP", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token, shareId } = yield* guestShares.redeem(
      { credential, name: "Sam" },
      "203.0.113.1",
    );
    yield* guestShares.check(token, "203.0.113.2");
    const moved = (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!;
    assert.equal(moved.guests![0]!.ipAddress, "203.0.113.2");
    assert.equal(moved.useCount, 1);
    yield* guestShares.submit(token, { shareId, text: "A note" }, [], "203.0.113.2");
    const guestId = moved.guests![0]!.id;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.ban",
      commandId: CommandId.make("ban-latest-ip"),
      threadId,
      guestId,
    });
    const banned = (yield* orchestrator.getThreadRecords(threadId, [])).thread;
    assert.deepEqual(banned.guestBannedIps, ["203.0.113.2"]);
    assert.equal(
      (yield* guestShares.check(token, "203.0.113.1").pipe(Effect.flip)).reason,
      "inactive",
    );
    const replacement = yield* guestShares.create({ threadId });
    const nextCredential = replacement.url.split("#")[1]!;
    assert.equal(
      (yield* guestShares
        .redeem({ credential: nextCredential, name: "Banned" }, "203.0.113.2")
        .pipe(Effect.flip)).reason,
      "inactive",
    );
    const joined = yield* guestShares.redeem(
      { credential: nextCredential, name: "New" },
      "203.0.113.1",
    );
    assert.equal(
      (yield* guestShares.check(joined.token, "203.0.113.2").pipe(Effect.flip)).reason,
      "inactive",
    );
    yield* guestShares.check(joined.token, "203.0.113.3");
    const nextGuest = (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!
      .guests![0]!;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.kick",
      commandId: CommandId.make("kick-moving-guest"),
      threadId,
      guestId: nextGuest.id,
    });
    assert.equal(
      (yield* guestShares.check(joined.token, "203.0.113.4").pipe(Effect.flip)).reason,
      "inactive",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not let an older open output stream overwrite a guest's newer IP", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token } = yield* guestShares.redeem({ credential, name: "Sam" }, "203.0.113.1");
    const command = yield* writeCommand("item:network-change", { status: "running" });
    const collecting = yield* Stream.runCollect(
      yield* guestShares.commandOutput(token, command, "203.0.113.1"),
    ).pipe(Effect.forkChild);
    yield* guestShares.check(token, "203.0.113.2");
    yield* TestClock.adjust("30 seconds");
    assert.equal(
      (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!.guests![0]!.ipAddress,
      "203.0.113.2",
    );
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-old-output"),
      threadId,
    });
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(collecting);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "isolates guest sessions, keeps nickname attribution, and revokes only a kicked guest",
  () =>
    Effect.gen(function* () {
      const { guestShares, orchestrator } = yield* shareThread;
      const { url, share } = yield* guestShares.create({
        threadId,
        permission: "confirm",
        maxGuests: 2,
        durationHours: 2,
      });
      const credential = url.split("#")[1]!;
      const sam = yield* guestShares.redeem({ credential, name: "Sam" }, "203.0.113.1");
      const eve = yield* guestShares.redeem({ credential, name: "Eve" }, "203.0.113.2");
      assert.notEqual(sam.token, eve.token);
      yield* guestShares.submit(sam.token, { shareId: share.id, text: "Sam's note" }, []);
      const before = (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!;
      assert.equal(before.messages[0]?.guestName, "Sam");
      const note = before.messages[0]!;
      const edit = {
        shareId: share.id,
        guestMessageId: note.id,
        text: "Sam's revised note",
        expectedRevision: 0,
        requestId: "revise-sam",
      };
      assert.equal(
        (yield* Effect.flip(guestShares.edit(eve.token, edit, "203.0.113.2"))).reason,
        "rejected",
      );
      assert.equal(
        (yield* Effect.flip(
          guestShares.deleteMessage(
            eve.token,
            { shareId: share.id, guestMessageId: note.id, requestId: "delete-sam" },
            "203.0.113.2",
          ),
        )).reason,
        "rejected",
      );
      yield* guestShares.edit(sam.token, { ...edit, requestId: "owner-revise-sam" }, "203.0.113.1");
      const samId = before.guests!.find((guest) => guest.name === "Sam")!.id;
      const events = yield* guestShares.stream(sam.token);
      yield* orchestrator.dispatch({
        type: "thread.guest-share.kick",
        commandId: CommandId.make("kick-sam"),
        threadId,
        guestId: samId,
      });
      assert.equal((yield* guestShares.check(sam.token).pipe(Effect.flip)).reason, "inactive");
      yield* guestShares.check(eve.token, "203.0.113.2");
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(guestShares.redeem({ credential, name: "Again" }))),
      );
      assert.equal((yield* Stream.runCollect(events)).at(-1)?.type, "ended");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps IP bans scoped to a chat across replacement links and allows unban", () =>
  Effect.gen(function* () {
    const { guestShares, orchestrator, credential } = yield* shareThread;
    yield* guestShares.redeem({ credential, name: "Sam" });
    const guestId = (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!
      .guests![0]!.id;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.ban",
      commandId: CommandId.make("ban-sam"),
      threadId,
      guestId,
    });
    const replacement = yield* guestShares.create({ threadId });
    const next = replacement.url.split("#")[1]!;
    assert.equal(
      (yield* guestShares.redeem({ credential: next, name: "Sam" }).pipe(Effect.flip)).reason,
      "inactive",
    );
    const other = yield* shareThreadFor(ThreadId.make("thread:separate-chat"));
    yield* other.guestShares.redeem({ credential: other.credential, name: "Sam" });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.unban",
      commandId: CommandId.make("unban-sam"),
      threadId,
      ipAddress: "203.0.113.1",
    });
    yield* guestShares.redeem({ credential: next, name: "Sam" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects viewer messages and sends direct guest messages once through normal intake",
  () =>
    Effect.gen(function* () {
      const { guestShares, orchestrator } = yield* shareThread;
      const viewer = yield* guestShares.create({ threadId });
      const watch = yield* guestShares.redeem({
        credential: viewer.url.split("#")[1]!,
        name: "Watch",
      });
      assert.equal(
        (yield* guestShares
          .submit(watch.token, { shareId: viewer.share.id, text: "No" }, [])
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      const direct = yield* guestShares.create({ threadId, permission: "send" });
      const writer = yield* guestShares.redeem({
        credential: direct.url.split("#")[1]!,
        name: "Sam",
      });
      const request = { shareId: direct.share.id, text: "Fix the issue", requestId: "request-1" };
      yield* guestShares.submit(writer.token, request, []);
      yield* guestShares.submit(writer.token, request, []);
      const records = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.equal(records.messages.length, 1);
      assert.equal(records.messages[0]?.context?.guest?.name, "Sam");
      assert.equal(records.thread.guestShare?.messages[0]?.status, "sent");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not expose guest IPs in guest view, snapshots, or live thread events", () =>
  Effect.gen(function* () {
    const { guestShares, orchestrator, credential } = yield* shareThread;
    const { token } = yield* guestShares.redeem({ credential, name: "Sam" });
    const events = yield* guestShares.stream(token);
    yield* guestShares.submit(
      token,
      {
        shareId: (yield* orchestrator.getThreadRecords(threadId, [])).thread.guestShare!.id,
        text: "A note",
      },
      [],
    );
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin-private-stream"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-private-stream"),
      threadId,
    });
    const received = yield* Stream.runCollect(events);
    const json = JSON.stringify(received);
    assert.notInclude(json, "203.0.113.1");
    assert.notInclude(json, "ipAddress");
    assert.notInclude(json, "guestBannedIps");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("spends an invite once and ends the guest stream when the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const again = yield* Effect.exit(guestShares.redeem({ credential, name: "Eve" }));
    assert.isTrue(Exit.isFailure(again));
    // The browser that joined can come back without the spent invite.
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.check(session))));
    // An invite token is not a session token.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(credential))));

    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-guest-share"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.deepEqual(
      received.map((event) => (event.type === "thread" ? event.item.kind : event.type)),
      ["view", "snapshot", "ended"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams the owner's thread events after the share and a snapshot", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message"),
      threadId,
      messageId: MessageId.make("message:owner"),
      text: "Fix the login bug",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-message"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.equal(received.at(-1)?.type, "ended");
    const turnItems = received.flatMap((event) =>
      event.type === "thread" &&
      event.item.kind === "event" &&
      event.item.event.type === "turn-item.updated"
        ? [event.item.event.payload]
        : [],
    );
    assert.deepEqual(
      turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
      ["Fix the login bug"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("starts a stream with the runs and items already in the thread", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message-before"),
      threadId,
      messageId: MessageId.make("message:before"),
      text: "Fix the login bug",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const [view, snapshot] = Array.from(
      yield* Stream.runCollect(Stream.take(yield* guestShares.stream(session), 2)),
    );
    assert.equal(view?.type, "view");
    if (snapshot?.type !== "thread" || snapshot.item.kind !== "snapshot") {
      return assert.fail("Expected the thread snapshot second.");
    }
    assert.equal(snapshot.item.projection.runs.length, 1);
    assert.include(
      snapshot.item.projection.visibleTurnItems.map((row) => row.item.type),
      "user_message",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("redeems only a short invite whose signature and share id are both current", () =>
  Effect.gen(function* () {
    const { guestShares, credential: replaced } = yield* shareThread;
    const { url } = yield* guestShares.create({ threadId, permission: "confirm" });
    const credential = url.slice(url.indexOf("#") + 1);
    assert.match(credential, /^[\w-]{22}\.[\w-]{22}$/);

    const [shareId, signature] = credential.split(".");
    const tampered = `${shareId}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    for (const rejected of [tampered, replaced]) {
      const error = yield* Effect.flip(guestShares.redeem({ credential: rejected, name: "Eve" }));
      assert.equal(error.reason, "invalid");
    }
    assert.isTrue(
      Exit.isSuccess(yield* Effect.exit(guestShares.redeem({ credential, name: "Sam" }))),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses guest requests once T3 Connect no longer serves the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const { id: shareId } = (yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadRecords(threadId, []),
    )).thread.guestShare!;
    yield* Ref.set(hostname, null);
    const submitted = yield* Effect.exit(
      guestShares.submit(session, { shareId, text: "Hello" }, []),
    );
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("closes an open guest stream when T3 Connect stops serving the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    yield* Ref.set(hostname, null);
    yield* TestClock.adjust("30 seconds");
    // No `ended`: the browser reconnects, and the host check refuses it while Connect is gone.
    const received = Array.from(yield* Fiber.join(collecting));
    assert.deepEqual(
      received.map((event) => (event.type === "thread" ? event.item.kind : event.type)),
      ["view", "snapshot"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
    yield* Ref.set(hostname, "env.t3.test");
    yield* Ref.set(publicRoute, null);
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.stream(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses new links and every guest request while the beta is off", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ guestSharingEnabled: false });
    // An open stream closes at the next access check.
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(collecting);
    assert.equal((yield* Effect.flip(guestShares.create({ threadId }))).reason, "disabled");
    assert.equal((yield* Effect.flip(guestShares.check(session))).reason, "inactive");
    // Turning it back on lets the same guest back in.
    yield* settings.updateSettings({ guestSharingEnabled: true });
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends an open guest stream when the link expires", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("25 hours");
    const received = Array.from(yield* Fiber.join(collecting));
    assert.equal(received.at(-1)?.type, "ended");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shows the guest the thread's new model", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("switch-model"),
      threadId,
      modelSelection: { instanceId, model: "gpt-5.2-codex" },
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-switch"),
      threadId,
    });
    const views = Array.from(yield* Stream.runCollect(events)).flatMap((event) =>
      event.type === "view" ? [event.view.model.name] : [],
    );
    assert.include(views, "gpt-5.2-codex");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a message a page sends for a share the cookie no longer opens", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const submitted = yield* Effect.exit(
      guestShares.submit(session, { shareId: GuestShareId.make("share:older"), text: "Hello" }, []),
    );
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serves no render for an item outside the shared thread", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.render(session, "item:missing"))));
    // The invite itself is not a session.
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(guestShares.render(credential, "item:missing"))),
    );
  }).pipe(Effect.provide(layerTest)),
);

/** A message from the owner, which opens a run for the command below. */
const ownerRun = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("owner-message-for-command"),
    threadId,
    messageId: MessageId.make("message:command"),
    text: "Build it",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const { runs } = (yield* orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 10 }))
    .projection;
  return runs[0]!.id;
});

const writeCommand = (
  id: string,
  fields: Pick<
    Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
    "status" | "output"
  >,
) =>
  Effect.gen(function* () {
    const runId = yield* ownerRun;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            startedAt: now,
            completedAt: fields.status === "running" ? null : now,
            updatedAt: now,
            type: "command_execution",
            input: "ls /work/src",
            ...fields,
          },
        },
      ],
    });
    return TurnItemId.make(id);
  });

it.effect("gives the guest a command's detail and output, as the owner's row loads them", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const command = yield* writeCommand("item:command", {
      status: "completed",
      output: "/work/src/auth.ts\n",
    });

    const detail = (yield* guestShares.item(session, command)).item;
    assert.deepInclude(detail, { input: "ls /work/src", output: "/work/src/auth.ts\n" });
    const frames = Array.from(
      yield* Stream.runCollect(yield* guestShares.commandOutput(session, command)),
    );
    assert.deepEqual(frames, [
      { kind: "replace", text: "/work/src/auth.ts\n", truncated: false, running: false },
    ]);
    // Only with a session, and only for an item of this thread.
    const refused: ReadonlyArray<Effect.Effect<unknown, GuestShareService.GuestShareAccessError>> =
      [
        guestShares.item(credential, command),
        guestShares.commandOutput(credential, command),
        guestShares.item(session, "item:elsewhere"),
      ];
    for (const request of refused) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(request)));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a running command's output once the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const command = yield* writeCommand("item:running", { status: "running" });
    const collecting = yield* Stream.runCollect(
      yield* guestShares.commandOutput(session, command),
    ).pipe(Effect.forkChild);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-during-command"),
      threadId,
    });
    yield* TestClock.adjust("30 seconds");
    const frames = Array.from(yield* Fiber.join(collecting));
    assert.isTrue(frames.every((frame) => frame.running));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.commandOutput(session, command))));
  }).pipe(Effect.provide(layerTest)),
);

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const MIB = 1024 * 1024;

/** Files as the multipart parser leaves them: on disk, with the browser's name and type. */
const uploadsOf = Effect.fn(function* (
  files: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  return yield* Effect.forEach(files, (file, index) => {
    const path = `${directory}/${index}`;
    return fileSystem
      .writeFile(path, file.bytes)
      .pipe(Effect.as({ name: file.name, contentType: file.contentType, path }));
  });
});
const png = (name: string, sizeBytes = PNG.length) => {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(PNG);
  return { name, contentType: "image/png", bytes };
};

/** Every stored attachment file. */
const storedFiles = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(attachmentsDir).pipe(Effect.orElseSucceed(() => []));
});

const joinedGuest = Effect.gen(function* () {
  const shared = yield* shareThread;
  const { token: session, shareId } = yield* shared.guestShares.redeem({
    credential: shared.credential,
    name: "Sam",
  });
  return { ...shared, session, shareId };
});

const waitingMessages = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
  return thread.guestShare?.messages ?? [];
});

it.effect("refuses too many files, too many bytes, and images that are not what they say", () =>
  Effect.gen(function* () {
    const { guestShares, session, shareId } = yield* joinedGuest;
    const before = yield* storedFiles;
    const refused = [
      ["too_many_files", [1, 2, 3, 4, 5].map((index) => png(`${index}.png`))],
      ["too_large", [png("big.png", 10 * MIB + 1)]],
      ["unsupported_file", [{ name: "logo.svg", contentType: "image/svg+xml", bytes: PNG }]],
      [
        "unsupported_file",
        [{ name: "page.png", contentType: "image/png", bytes: new TextEncoder().encode("<html>") }],
      ],
      [
        "unsupported_file",
        [{ name: "empty.txt", contentType: "text/plain", bytes: new Uint8Array() }],
      ],
    ] as const;
    for (const [reason, files] of refused) {
      const error = yield* Effect.flip(
        guestShares.submit(session, { shareId, text: "Look" }, yield* uploadsOf(files)),
      );
      assert.equal(error.reason, reason);
    }
    // Nothing is kept from a refused message, and no message waits.
    assert.deepEqual(yield* storedFiles, before);
    assert.deepEqual(yield* waitingMessages, []);

    yield* guestShares.submit(
      session,
      { shareId, text: "" },
      yield* uploadsOf([
        png("screen.png"),
        // A direction override would make this name read as a PDF.
        {
          name: "notes\u202Efdp.html",
          contentType: "text/html",
          bytes: new TextEncoder().encode("<b>"),
        },
      ]),
    );
    const [message] = yield* waitingMessages;
    assert.deepEqual(
      message?.attachments?.map(({ type, name, mimeType, sizeBytes }) => ({
        type,
        name,
        mimeType,
        sizeBytes,
      })),
      [
        { type: "image", name: "screen.png", mimeType: "image/png", sizeBytes: PNG.length },
        { type: "file", name: "notes_fdp.html", mimeType: "text/html", sizeBytes: 3 },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("keeps only the accepted files when the same upload request races", () =>
  Effect.gen(function* () {
    const { guestShares, session, shareId } = yield* joinedGuest;
    const uploads = yield* uploadsOf([png("a.png")]);
    const request = { shareId, text: "Once", requestId: "same-upload" };
    yield* Effect.all(
      [
        guestShares.submit(session, request, uploads),
        guestShares.submit(session, request, uploads),
      ],
      { concurrency: 2 },
    );
    assert.equal((yield* waitingMessages).length, 1);
    assert.equal((yield* storedFiles).length, 1);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("removes retry copies after the accepted message leaves the bounded share history", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    const uploads = yield* uploadsOf([png("a.png")]);
    const request = { shareId, text: "Once", requestId: "trimmed-upload" };
    yield* guestShares.submit(session, request, uploads);
    const original = (yield* waitingMessages)[0]!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("accept-upload"),
      threadId,
      messageId: MessageId.make("accepted-upload"),
      guestMessageId: original.id,
      text: "",
      attachments: original.attachments!,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    for (let index = 0; index < 21; index += 1) {
      yield* guestShares.submit(session, { shareId, text: `note ${index}` }, []);
      const note = (yield* waitingMessages).find((message) => message.status === "pending")!;
      yield* orchestrator.dispatch({
        type: "thread.guest-message.dismiss",
        commandId: CommandId.make(`dismiss-replay-note-${index}`),
        threadId,
        guestMessageId: note.id,
      });
    }
    assert.isFalse((yield* waitingMessages).some((message) => message.id === original.id));
    yield* guestShares.submit(session, request, uploads);
    assert.equal((yield* storedFiles).length, 1);
    yield* guestShares.attachment(session, original.attachments![0]!.id);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("caps the bytes of files waiting in one share", () =>
  Effect.gen(function* () {
    const { guestShares, session, shareId } = yield* joinedGuest;
    const submit = (sizeBytes: number) =>
      Effect.gen(function* () {
        return guestShares.submit(
          session,
          { shareId, text: "Look" },
          yield* uploadsOf([png("big.png", sizeBytes)]),
        );
      }).pipe(Effect.flatten);
    yield* submit(9 * MIB);
    yield* submit(9 * MIB);
    const error = yield* Effect.flip(submit(9 * MIB));
    assert.equal(error.reason, "files_busy");
    // Text alone still goes through.
    yield* guestShares.submit(session, { shareId, text: "One more thing" }, []);
    assert.equal((yield* waitingMessages).length, 3);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("deletes a waiting message's files when the owner dismisses it or stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* guestShares.submit(
      session,
      { shareId, text: "First" },
      yield* uploadsOf([png("a.png")]),
    );
    yield* guestShares.submit(
      session,
      { shareId, text: "Second" },
      yield* uploadsOf([png("b.png")]),
    );
    const [first, second] = yield* waitingMessages;
    const fileOf = (message: typeof first) => message!.attachments![0]!.id;
    const stored = yield* storedFiles;
    assert.isTrue(stored.some((entry) => entry.startsWith(fileOf(first))));

    yield* orchestrator.dispatch({
      type: "thread.guest-message.dismiss",
      commandId: CommandId.make("dismiss-first"),
      threadId,
      guestMessageId: first!.id,
    });
    yield* worker.drain();
    const afterDismiss = yield* storedFiles;
    assert.isFalse(afterDismiss.some((entry) => entry.startsWith(fileOf(first))));
    assert.isTrue(afterDismiss.some((entry) => entry.startsWith(fileOf(second))));
    // A dismissed message's file is no longer the guest's to load.
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(guestShares.attachment(session, fileOf(first)))),
    );

    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-with-files"),
      threadId,
    });
    yield* worker.drain();
    assert.isFalse((yield* storedFiles).some((entry) => entry.startsWith(fileOf(second))));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "deletes a waiting message's files on %s",
  (type) =>
    Effect.gen(function* () {
      const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const before = yield* storedFiles;
      yield* guestShares.submit(
        session,
        { shareId, text: "Look" },
        yield* uploadsOf([png("a.png")]),
      );
      assert.equal((yield* storedFiles).length, before.length + 1);
      yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`${type}-with-files`),
        threadId,
      });
      yield* worker.drain();
      assert.deepEqual(yield* storedFiles, before);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("sends a guest's files as the guest's message and keeps them the guest's to load", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    yield* guestShares.submit(
      session,
      { shareId, text: "See this" },
      yield* uploadsOf([png("a.png")]),
    );
    const [message] = yield* waitingMessages;
    const pending = message!.attachments!;
    // Served while it waits.
    const served = yield* guestShares.attachment(session, pending[0]!.id);
    assert.equal(served.attachment.mimeType, "image/png");

    // The day-old pending-upload sweep leaves a waiting guest's files alone.
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    // Any pending upload counts as stale at the end of time.
    sweepStalePendingAttachments({ attachmentsDir, nowMs: Number.MAX_SAFE_INTEGER });
    const copied = pending[0]!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-files"),
      threadId,
      messageId: MessageId.make("message:guest-files"),
      guestMessageId: message!.id,
      text: "",
      attachments: [copied],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const items = (yield* orchestrator.getThreadSnapshotWindow(threadId, {
      rowLimit: 20,
    })).projection.visibleTurnItems.map((entry) => entry.item);
    const sent = items.find(
      (item) => item.type === "user_message" && item.context?.guest?.guestMessageId === message!.id,
    );
    assert.deepInclude(sent, { attachments: [copied] });
    if (sent?.type !== "user_message") return;
    assert.deepEqual(sent.context?.guest, {
      guestMessageId: message!.id,
      guestId: message!.guestId,
      name: "Sam",
      text: "See this",
      shareId,
    });
    // The guest loads the thread's copy from their own row.
    const fromRow = yield* guestShares.attachment(session, copied.id);
    assert.equal(fromRow.attachment.id, copied.id);

    // Still theirs after their share's message list has trimmed it away.
    for (let index = 0; index < 21; index += 1) {
      yield* guestShares.submit(session, { shareId, text: `note ${index}` }, []);
      const waiting = (yield* waitingMessages).find((next) => next.status === "pending");
      yield* orchestrator.dispatch({
        type: "thread.guest-message.dismiss",
        commandId: CommandId.make(`dismiss-note-${index}`),
        threadId,
        guestMessageId: waiting!.id,
      });
    }
    assert.isFalse((yield* waitingMessages).some((next) => next.id === message!.id));
    assert.equal((yield* guestShares.attachment(session, copied.id)).attachment.id, copied.id);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("serves the shared thread's files to its guest, never another thread's", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    // Another thread's guest attaches a file.
    const other = yield* shareThreadFor(ThreadId.make("thread:other-share"));
    const otherGuest = yield* guestShares.redeem({ credential: other.credential, name: "Eve" });
    yield* guestShares.submit(
      otherGuest.token,
      { shareId: otherGuest.shareId, text: "Mine" },
      yield* uploadsOf([png("eve.png")]),
    );
    const { thread: otherThread } = yield* orchestrator.getThreadRecords(
      ThreadId.make("thread:other-share"),
      [],
    );
    const othersFile = otherThread.guestShare!.messages[0]!.attachments![0]!.id;
    assert.isTrue(
      Exit.isSuccess(yield* Effect.exit(guestShares.attachment(otherGuest.token, othersFile))),
    );

    // The owner sends a message with an image of their own.
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const ownerImage = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId(threadId)!),
      name: "secret.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
    };
    yield* fileSystem.writeFile(
      resolveAttachmentPath({ attachmentsDir, attachment: ownerImage })!,
      PNG,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-image"),
      threadId,
      messageId: MessageId.make("message:owner-image"),
      text: "My screen",
      attachments: [ownerImage],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    // The guest sees the thread as the owner does, files included.
    assert.equal(
      (yield* guestShares.attachment(session, ownerImage.id)).attachment.id,
      ownerImage.id,
    );
    for (const id of [othersFile, "pending-missing"]) {
      const error = yield* Effect.flip(guestShares.attachment(session, id));
      assert.equal(error.reason, "unavailable");
    }
    // Nor with the other share's id on this page.
    assert.equal(
      (yield* Effect.flip(
        guestShares.submit(session, { shareId: otherGuest.shareId, text: "x" }, []),
      )).reason,
      "stale_page",
    );
    assert.isDefined(shareId);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "authenticates guest edits, preserves attachments and removes deleted pending requests",
  () =>
    Effect.gen(function* () {
      const { guestShares, orchestrator, session, shareId } = yield* joinedGuest;
      yield* guestShares.submit(
        session,
        { shareId, text: "First", requestId: "original" },
        yield* uploadsOf([png("edit.png")]),
      );
      const original = (yield* waitingMessages)[0]!;
      const edit = {
        shareId,
        guestMessageId: original.id,
        text: "Updated",
        expectedRevision: 0,
        requestId: "edit-1",
      };
      const denied = yield* Effect.flip(guestShares.edit("bad-session", edit, "203.0.113.1"));
      assert.equal(denied.reason, "invalid");
      yield* guestShares.edit(session, edit, "203.0.113.1");
      yield* guestShares.edit(session, edit, "203.0.113.1");
      const updated = (yield* waitingMessages)[0]!;
      assert.equal(updated.text, "Updated");
      assert.equal(updated.revision, 1);
      assert.deepEqual(updated.attachments, original.attachments);
      assert.equal((yield* storedFiles).length, 1);
      const stale = yield* Effect.flip(
        guestShares.edit(session, { ...edit, text: "Stale", requestId: "stale" }, "203.0.113.1"),
      );
      assert.equal(stale.reason, "rejected");
      yield* guestShares.deleteMessage(
        session,
        { shareId, guestMessageId: original.id, requestId: "delete" },
        "203.0.113.1",
      );
      const current = (yield* waitingMessages)[0]!;
      assert.isDefined(current.deletedAt);
      assert.equal(current.status, "dismissed");
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("approve-deleted"),
              threadId,
              messageId: MessageId.make("deleted"),
              guestMessageId: original.id,
              guestMessageRevision: 1,
              text: "",
              attachments: [],
              dispatchMode: { type: "defer_start" },
              createdBy: "user",
              creationSource: "web",
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("deletes an owned sent message after its moderation record was trimmed", () =>
  Effect.gen(function* () {
    const { guestShares, orchestrator, session, shareId } = yield* joinedGuest;
    yield* guestShares.submit(session, { shareId, text: "Old sent message" }, []);
    const original = (yield* waitingMessages)[0]!;
    const messageId = MessageId.make("old-accepted");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("accept-old"),
      threadId,
      messageId,
      guestMessageId: original.id,
      text: "",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    for (let index = 0; index < 21; index += 1) {
      yield* guestShares.submit(session, { shareId, text: `Note ${index}` }, []);
      const pending = (yield* waitingMessages).find((message) => message.status === "pending")!;
      yield* orchestrator.dispatch({
        type: "thread.guest-message.dismiss",
        commandId: CommandId.make(`dismiss-${index}`),
        threadId,
        guestMessageId: pending.id,
      });
    }
    assert.isFalse((yield* waitingMessages).some((message) => message.id === original.id));
    yield* guestShares.deleteMessage(
      session,
      { shareId, messageId, guestMessageId: original.id, requestId: "delete-old" },
      "203.0.113.1",
    );
    assert.isAtMost(
      (yield* waitingMessages).filter((message) => message.status !== "pending").length,
      20,
    );
    const records = yield* orchestrator.getThreadRecords(threadId, ["messages", "turnItems"]);
    assert.isDefined(
      records.messages.find((message) => message.id === messageId)?.context?.guest?.deletedAt,
    );
    assert.isDefined(
      records.turnItems.find(
        (item) =>
          item.type === "user_message" &&
          item.messageId === messageId &&
          item.context?.guest?.deletedAt,
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);
