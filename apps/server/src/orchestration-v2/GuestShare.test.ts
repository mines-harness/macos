import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GuestMessageId,
  GuestSessionId,
  GuestShareId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { decideGuestShareCommand } from "./GuestShareDecider.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:guest-share");
const shareId = GuestShareId.make("share:one");
const guestMessageId = GuestMessageId.make("guest-message:one");
const guestId = GuestSessionId.make("guest:one");
const otherGuestId = GuestSessionId.make("guest:two");

const openConfigured = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  permission: "viewer" | "confirm" | "send",
  maxGuests = 2,
  id = "configured",
) =>
  Effect.gen(function* () {
    yield* orchestrator.dispatch({
      type: "thread.guest-share.open",
      commandId: CommandId.make(`open-${id}`),
      threadId,
      shareId,
      host: "env.t3.test",
      expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 6 })),
      permission,
      maxGuests,
    });
  });

const redeemIdentity = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  identity = guestId,
  ipAddress = "192.0.2.1",
  guestName = "Sam",
) =>
  orchestrator.dispatch({
    type: "thread.guest-share.redeem",
    commandId: CommandId.make(id),
    threadId,
    shareId,
    guestId: identity,
    ipAddress,
    guestName,
  });

const submitIdentity = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  text = "Hello",
  identity = guestId,
) =>
  orchestrator.dispatch({
    type: "thread.guest-message.submit",
    commandId: CommandId.make(id),
    threadId,
    shareId,
    guestMessageId,
    guestId: identity,
    text,
  });

const updateGuestIp = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  ipAddress: string,
  identity = guestId,
  activeShareId = shareId,
) =>
  orchestrator.dispatch({
    type: "thread.guest-share.update-ip",
    commandId: CommandId.make(id),
    threadId,
    shareId: activeShareId,
    guestId: identity,
    ipAddress,
  });

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-guest-share"),
    threadId,
    projectId: ProjectId.make("project:guest-share"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.guest-share.open",
    commandId: CommandId.make("open-guest-share"),
    threadId,
    shareId,
    host: "env.t3.test",
    expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 })),
  });
  return orchestrator;
});

const sendGuestMessage = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    guestMessageId,
    text: "ignored: the server sends the guest's own text",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });

it.effect("keeps a guest identity and lifetime usage when its network IP changes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm");
    yield* redeemIdentity(orchestrator, "redeem-first");
    yield* redeemIdentity(orchestrator, "redeem-second", otherGuestId);
    const before = (yield* projections.getThreadProjection(threadId)).thread.guestShare;
    const unchanged = yield* updateGuestIp(orchestrator, "same-ip", "192.0.2.1");
    assert.lengthOf(unchanged.storedEvents, 0);
    yield* updateGuestIp(orchestrator, "new-network", "198.51.100.1");
    const after = (yield* projections.getThreadProjection(threadId)).thread.guestShare;
    assert.equal(after?.useCount, before?.useCount);
    assert.deepEqual(
      after?.guests,
      before?.guests?.map((guest) =>
        guest.id === guestId ? { ...guest, ipAddress: "198.51.100.1" } : guest,
      ),
    );
    yield* submitIdentity(orchestrator, "submit-new-network");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.ban",
      commandId: CommandId.make("ban-current-ip"),
      threadId,
      guestId,
    });
    const banned = (yield* projections.getThreadProjection(threadId)).thread;
    assert.deepEqual(banned.guestBannedIps, ["198.51.100.1"]);
    assert.deepEqual(
      banned.guestShare?.guests?.map((guest) => guest.id),
      [otherGuestId],
    );
    assert.equal(banned.guestShare?.useCount, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects IP updates for banned addresses, missing guests, stale links, and expired links",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* openConfigured(orchestrator, "confirm");
      yield* redeemIdentity(orchestrator, "redeem-first");
      yield* redeemIdentity(orchestrator, "redeem-second", otherGuestId, "198.51.100.1");
      yield* orchestrator.dispatch({
        type: "thread.guest-share.ban",
        commandId: CommandId.make("ban-other"),
        threadId,
        guestId: otherGuestId,
      });
      for (const update of [
        updateGuestIp(orchestrator, "banned-ip", "198.51.100.1"),
        updateGuestIp(
          orchestrator,
          "missing-guest",
          "192.0.2.2",
          GuestSessionId.make("guest:missing"),
        ),
        updateGuestIp(
          orchestrator,
          "stale-link",
          "192.0.2.2",
          guestId,
          GuestShareId.make("share:old"),
        ),
      ])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(update)));
      assert.equal(
        (yield* projections.getThreadProjection(threadId)).thread.guestShare?.guests?.[0]
          ?.ipAddress,
        "192.0.2.1",
      );
      yield* orchestrator.dispatch({
        type: "thread.guest-share.kick",
        commandId: CommandId.make("kick-first"),
        threadId,
        guestId,
      });
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(updateGuestIp(orchestrator, "kicked-ip", "192.0.2.2"))),
      );
      yield* openConfigured(orchestrator, "confirm", 2, "expired-ip");
      yield* redeemIdentity(orchestrator, "redeem-again");
      yield* TestClock.adjust("6 hours");
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(updateGuestIp(orchestrator, "expired-ip", "192.0.2.1"))),
      );
      yield* orchestrator.dispatch({
        type: "thread.guest-share.close",
        commandId: CommandId.make("close-ip"),
        threadId,
      });
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(updateGuestIp(orchestrator, "closed-ip", "192.0.2.1"))),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("limits lifetime redemptions without refunding kicked guests", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm", 2);
    yield* redeemIdentity(orchestrator, "redeem-sam");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(redeemIdentity(orchestrator, "duplicate-id"))));
    yield* redeemIdentity(orchestrator, "redeem-lee", otherGuestId, "192.0.2.2", "Lee");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.kick",
      commandId: CommandId.make("kick"),
      threadId,
      guestId,
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          redeemIdentity(orchestrator, "over-capacity", GuestSessionId.make("guest:three")),
        ),
      ),
    );
    const { thread } = yield* projections.getThreadProjection(threadId);
    assert.equal(thread.guestShare?.useCount, 2);
    assert.deepEqual(
      thread.guestShare?.guests?.map((guest) => guest.id),
      [otherGuestId],
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(submitIdentity(orchestrator, "kicked-submit"))),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serializes competing redemptions at the lifetime limit", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm", 1);
    const redemptions = yield* Effect.all(
      [
        Effect.exit(redeemIdentity(orchestrator, "redeem-first")),
        Effect.exit(redeemIdentity(orchestrator, "redeem-second", otherGuestId)),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(redemptions.filter(Exit.isSuccess).length, 1);
    const share = (yield* projections.getThreadProjection(threadId)).thread.guestShare;
    assert.equal(share?.useCount, 1);
    assert.lengthOf(share?.guests ?? [], 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("retains legacy redemption counts during moderation and refuses overflowing bans", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm");
    yield* redeemIdentity(orchestrator, "redeem-first");
    yield* redeemIdentity(orchestrator, "redeem-second", otherGuestId);
    const thread = (yield* projections.getThreadProjection(threadId)).thread;
    if (thread.guestShare === null || thread.guestShare === undefined) {
      return assert.fail("Expected the configured guest share.");
    }
    const now = yield* DateTime.now;
    const { useCount: _useCount, ...legacyShare } = thread.guestShare;
    const kicked = decideGuestShareCommand({
      thread: { ...thread, guestShare: { ...legacyShare, guestName: null } },
      now,
      command: {
        type: "thread.guest-share.kick",
        commandId: CommandId.make("kick-legacy"),
        threadId,
        guestId,
      },
    });
    assert.isTrue(Result.isSuccess(kicked));
    if (Result.isSuccess(kicked)) assert.equal(kicked.success.guestShare?.useCount, 2);
    const full = decideGuestShareCommand({
      thread: {
        ...thread,
        guestBannedIps: Array.from({ length: 1_000 }, (_, i) => `198.51.100.${i}`),
      },
      now,
      command: {
        type: "thread.guest-share.ban",
        commandId: CommandId.make("ban-full"),
        threadId,
        guestId,
      },
    });
    assert.isTrue(Result.isFailure(full));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("persists IP bans across close and replacement and removes matching sessions", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm", 4);
    yield* redeemIdentity(orchestrator, "redeem-sam");
    yield* redeemIdentity(orchestrator, "redeem-lee", otherGuestId);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.ban",
      commandId: CommandId.make("ban"),
      threadId,
      guestId,
    });
    const banned = (yield* projections.getThreadProjection(threadId)).thread;
    assert.deepEqual(banned.guestBannedIps, ["192.0.2.1"]);
    assert.deepEqual(banned.guestShare?.guests, []);
    assert.equal(banned.guestShare?.useCount, 2);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close"),
      threadId,
    });
    yield* openConfigured(orchestrator, "confirm", 4, "replacement");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(redeemIdentity(orchestrator, "banned-redeem"))),
    );
    yield* orchestrator.dispatch({
      type: "thread.guest-share.unban",
      commandId: CommandId.make("unban"),
      threadId,
      ipAddress: "192.0.2.1",
    });
    yield* redeemIdentity(orchestrator, "unbanned-redeem");
    assert.deepEqual((yield* projections.getThreadProjection(threadId)).thread.guestBannedIps, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects viewer submissions and snapshots each confirming author's name", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "viewer");
    yield* redeemIdentity(orchestrator, "redeem-viewer");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(submitIdentity(orchestrator, "viewer-submit"))),
    );
    yield* openConfigured(orchestrator, "confirm", 2, "confirm");
    yield* redeemIdentity(orchestrator, "redeem-first");
    yield* redeemIdentity(orchestrator, "redeem-second", otherGuestId, "192.0.2.2", "Lee");
    yield* submitIdentity(orchestrator, "submit-lee", "Why?", otherGuestId);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.kick",
      commandId: CommandId.make("kick-lee"),
      threadId,
      guestId: otherGuestId,
    });
    yield* sendGuestMessage(orchestrator, "send-lee");
    const projection = yield* projections.getThreadProjection(threadId);
    const submitted = projection.thread.guestShare?.messages[0];
    assert.equal(submitted?.guestId, otherGuestId);
    assert.equal(submitted?.guestName, "Lee");
    assert.equal(
      projection.messages[0]?.text,
      "Message from guest Lee, sent by the owner:\n\nWhy?",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deduplicates identical submissions and rejects conflicting retry payloads", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "confirm");
    yield* redeemIdentity(orchestrator, "redeem");
    yield* submitIdentity(orchestrator, "submit-first");
    yield* submitIdentity(orchestrator, "submit-retry");
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(submitIdentity(orchestrator, "submit-conflict", "Different")),
      ),
    );
    assert.lengthOf(
      (yield* projections.getThreadProjection(threadId)).thread.guestShare?.messages ?? [],
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sends direct messages once and rejects sends after their author is kicked", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "send");
    yield* redeemIdentity(orchestrator, "redeem");
    yield* submitIdentity(orchestrator, "submit");
    assert.isTrue(
      (yield* projections.getThreadProjection(threadId)).thread.guestShare?.messages[0]?.direct,
    );
    yield* sendGuestMessage(orchestrator, "send-direct");
    yield* submitIdentity(orchestrator, "submit-after-send");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-direct-again"))),
    );
    const projection = yield* projections.getThreadProjection(threadId);
    assert.lengthOf(projection.messages, 1);
    assert.equal(projection.messages[0]?.text, "Message from guest Sam:\n\nHello");
    yield* openConfigured(orchestrator, "send", 2, "kicked");
    yield* redeemIdentity(orchestrator, "redeem-kicked");
    yield* submitIdentity(orchestrator, "submit-kicked");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.kick",
      commandId: CommandId.make("kick-direct"),
      threadId,
      guestId,
    });
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-kicked"))),
    );
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a direct send when its link expires or its author is banned", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* openConfigured(orchestrator, "send");
    yield* redeemIdentity(orchestrator, "redeem");
    yield* submitIdentity(orchestrator, "submit");
    yield* TestClock.adjust("6 hours");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-expired"))),
    );
    yield* openConfigured(orchestrator, "send", 2, "ban-race");
    yield* redeemIdentity(orchestrator, "redeem-ban");
    yield* submitIdentity(orchestrator, "submit-ban");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.ban",
      commandId: CommandId.make("ban-direct"),
      threadId,
      guestId,
    });
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-banned"))),
    );
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).messages, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("redeems a guest link once and sends each guest message once, with its turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const redeem = (id: string) =>
      orchestrator.dispatch({
        type: "thread.guest-share.redeem",
        commandId: CommandId.make(id),
        threadId,
        shareId,
        guestName: "Sam",
      });
    yield* redeem("redeem-1");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(redeem("redeem-2"))));

    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-1"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why not keep the old cache?",
    });
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 1);

    yield* sendGuestMessage(orchestrator, "send-1");
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(
      projection.thread.guestShare?.messages.map((message) => message.status),
      ["sent"],
    );
    const sent = projection.messages.find((message) => message.id === MessageId.make("send-1"));
    assert.equal(
      sent?.text,
      "Message from guest Sam, sent by the owner:\n\nWhy not keep the old cache?",
    );
    assert.deepEqual(sent?.context?.guest, {
      guestMessageId,
      name: "Sam",
      text: "Why not keep the old cache?",
      shareId,
    });
    assert.lengthOf(projection.runs, 1);
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 0);

    // A second owner device clicking Send must not start another turn.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-2"))));
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects guest messages until the link is redeemed and after archive", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const submit = orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-early"),
      threadId,
      shareId,
      guestMessageId,
      text: "Hello",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(submit)));

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-guest-share"),
      threadId,
    });
    assert.isNull((yield* projections.getThread(threadId)).guestShare ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("drops guest attribution that a client sends on its own message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message"),
      threadId,
      messageId: MessageId.make("owner-message"),
      text: "Mine",
      context: { version: 1, records: [], guest: { guestMessageId, name: "Sam", text: "Mine" } },
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* projections.getThreadProjection(threadId);
    const sent = projection.messages.find(
      (message) => message.id === MessageId.make("owner-message"),
    );
    assert.isUndefined(sent?.context?.guest);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a queued guest message unchanged when the owner tries to edit it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-first"),
      threadId,
      messageId: MessageId.make("owner-first"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-queued"),
      threadId,
      messageId: MessageId.make("send-queued"),
      guestMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);

    const edit = orchestrator.dispatch({
      type: "queued-run.edit",
      commandId: CommandId.make("edit"),
      threadId,
      runId: queued.id,
      text: "My own words",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(edit)));
    const message = (yield* projections.getThreadProjection(threadId)).messages.find(
      (candidate) => candidate.id === MessageId.make("send-queued"),
    );
    assert.equal(message?.context?.guest?.text, "Why?");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shows a guest message as dismissed when the owner cancels its queued send", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-first"),
      threadId,
      messageId: MessageId.make("owner-first"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-queued"),
      threadId,
      messageId: MessageId.make("send-queued"),
      guestMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel"),
      threadId,
      runId: queued.id,
    });
    const { thread } = yield* projections.getThreadProjection(threadId);
    assert.equal(
      thread.guestShare?.messages.find((message) => message.id === guestMessageId)?.status,
      "dismissed",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("brings a settled thread back when its guest sends a request", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle"),
      threadId,
    });
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).thread.settledOverride,
      "settled",
    );
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    const { thread } = yield* projections.getThreadProjection(threadId);
    assert.isNull(thread.settledOverride);
    assert.isNull(thread.settledAt);
  }).pipe(Effect.provide(layerTest)),
);
