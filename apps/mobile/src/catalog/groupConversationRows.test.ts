import { expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { GroupRunProjection } from "@t3tools/contracts/groupChat";
import { groupMessageProjection, unplacedGroupProjections } from "./groupConversationRows";

const projection: GroupRunProjection = {
  deliveryId: "delivery",
  memberId: "mine",
  environmentId: EnvironmentId.make("actual-source"),
  threadId: ThreadId.make("actual-mine"),
  runId: RunId.make("actual-run"),
  items: [
    {
      id: TurnItemId.make("answer"),
      threadId: ThreadId.make("actual-mine"),
      runId: RunId.make("actual-run"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: DateTime.makeUnsafe("2026-10-29T10:00:00Z"),
      completedAt: DateTime.makeUnsafe("2026-10-29T10:00:00Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-29T10:00:00Z"),
      type: "assistant_message",
      messageId: MessageId.make("answer"),
      text: "Answer",
      streaming: false,
    },
  ],
  runtimeRequests: [],
  deferredItems: [],
  hasMoreItems: false,
  beforeOrdinal: null,
};

it("replaces only a matching member's reply with its genuine run projection", () => {
  expect(
    groupMessageProjection([projection], {
      id: "reply:delivery",
      kind: "assistant",
      memberId: "mine",
    }),
  ).toBe(projection);
  expect(
    groupMessageProjection([projection], {
      id: "reply:delivery",
      kind: "assistant",
      memberId: "other",
    }),
  ).toBeUndefined();
  expect(
    groupMessageProjection([projection], {
      id: "message",
      kind: "assistant",
      memberId: "mine",
      sourceRunId: projection.runId,
    }),
  ).toBe(projection);
  expect(
    groupMessageProjection([projection], { id: "reply:delivery", kind: "user", memberId: "mine" }),
  ).toBeUndefined();
});

it("keeps active work visible before a reply exists without duplicating a published reply", () => {
  expect(unplacedGroupProjections([projection], [])).toEqual([projection]);
  expect(
    unplacedGroupProjections(
      [projection],
      [{ id: "reply:delivery", kind: "assistant", memberId: "mine" }],
    ),
  ).toEqual([]);
});

it("preserves the flat reply until native items exist while offering deferred activity separately", () => {
  const reply = { id: "reply:delivery", kind: "assistant" as const, memberId: "mine" };
  const empty = { ...projection, items: [] };
  expect(groupMessageProjection([empty], reply)).toBeUndefined();
  expect(unplacedGroupProjections([empty], [reply])).toEqual([]);
  const deferred = {
    ...empty,
    deferredItems: [{ id: TurnItemId.make("deferred"), ordinal: 1, revision: "revision" }],
  };
  expect(groupMessageProjection([deferred], reply)).toBeUndefined();
  expect(unplacedGroupProjections([deferred], [reply])).toEqual([deferred]);
});
