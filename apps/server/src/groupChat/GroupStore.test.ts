import { assert, it } from "@effect/vitest";
import {
  GroupId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Group,
  type GroupMember,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GroupStore from "./GroupStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const layer = GroupStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const at = IsoDateTime.make("2026-10-25T00:00:00.000Z");
const group = (id: string): Group => ({
  id: GroupId.make(id),
  name: id,
  workflow: "team",
  leadMemberId: `member:${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
});
const member = (groupId: GroupId): GroupMember => ({
  id: `member:${groupId}`,
  groupId,
  threadId: ThreadId.make("thread:original"),
  projectId: ProjectId.make("project:one"),
  environmentId: null,
  alias: "UX",
  role: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  joinedAt: at,
});

it.effect(
  "enforces one active group per original thread and rolls back a conflicting creation",
  () =>
    Effect.gen(function* () {
      const store = yield* GroupStore.GroupStore;
      const first = group("group:first");
      const second = group("group:second");
      yield* store.commit({
        groupId: first.id,
        group: first,
        members: [member(first.id)],
        at,
        kind: "group.created",
      });
      const duplicate = yield* store
        .commit({
          groupId: second.id,
          group: second,
          members: [member(second.id)],
          at,
          kind: "group.created",
        })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal((yield* store.list()).length, 1);
      assert.equal((yield* store.membership("thread:original"))?.groupId, first.id);
      yield* store.commit({
        groupId: first.id,
        at,
        kind: "group.archived",
        group: { ...first, archivedAt: at },
        membershipActive: false,
      });
      yield* store.commit({
        groupId: second.id,
        group: second,
        members: [member(second.id)],
        at,
        kind: "group.created",
      });
      assert.equal((yield* store.membership("thread:original"))?.groupId, second.id);
    }).pipe(Effect.provide(layer)),
);

it.effect("commits user history, a pending round, and its receipt atomically for recovery", () =>
  Effect.gen(function* () {
    const store = yield* GroupStore.GroupStore;
    const record = group("group:durable");
    const participant = member(record.id);
    yield* store.commit({
      groupId: record.id,
      group: record,
      members: [participant],
      at,
      kind: "group.created",
    });
    yield* store.commit({
      groupId: record.id,
      at,
      kind: "round.started",
      round: {
        id: "round:one",
        groupId: record.id,
        userMessageId: "message:one",
        routing: "everyone",
        workflow: "team",
        status: "active",
        members: [participant],
        deliveries: [
          {
            id: "delivery:stable",
            memberId: participant.id,
            stage: "initial",
            status: "dispatching",
            runId: null,
            hop: 0,
            parentDeliveryId: null,
            request: "",
            contextThroughMessageId: "message:one",
            error: null,
          },
        ],
        createdAt: at,
        completedAt: null,
      },
      messages: [
        {
          id: "message:one",
          groupId: record.id,
          roundId: "round:one",
          memberId: null,
          kind: "user",
          text: "Work on this",
          createdAt: at,
          truncated: false,
        },
      ],
      receipt: { id: "request:stable", fingerprint: "same-input", result: "round:one" },
    });
    assert.equal((yield* store.activeRounds())[0]?.deliveries[0]?.id, "delivery:stable");
    assert.equal((yield* store.receipt("request:stable"))?.result, "round:one");
    assert.equal((yield* store.get(record.id)).messages[0]?.text, "Work on this");
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds snapshot bodies without losing the authoritative saved message", () =>
  Effect.gen(function* () {
    const store = yield* GroupStore.GroupStore;
    const record = group("group:bounded");
    const text = "x".repeat(200_000);
    yield* store.commit({
      groupId: record.id,
      group: record,
      at,
      kind: "group.created",
      messages: [
        {
          id: "message:large",
          groupId: record.id,
          roundId: "round:one",
          memberId: null,
          kind: "assistant",
          text,
          createdAt: at,
          truncated: false,
        },
      ],
    });
    const snapshot = yield* store.get(record.id);
    assert.equal(snapshot.messages[0]?.text.length, 32_000);
    assert.equal(snapshot.messages[0]?.truncated, true);
    assert.equal(
      (yield* store.messagesThrough(record.id, "message:large"))[0]?.text.length,
      text.length,
    );
  }).pipe(Effect.provide(layer)),
);
