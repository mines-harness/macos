import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { GroupRunProjection } from "@t3tools/contracts/groupChat";
import {
  groupRunRows,
  groupRunTargets,
  eligibleGroupRunProjections,
  missingGroupRunTargets,
  mergeGroupRunProjections,
  prependGroupRunBody,
} from "./GroupRunTranscript.logic";

const now = DateTime.makeUnsafe("2026-10-29T10:00:00.000Z");
const sourceThreadId = ThreadId.make("real-member-thread");
const runId = RunId.make("real-group-run");
const item = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId: sourceThreadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "assistant_message" as const,
  messageId: MessageId.make(id),
  text: id,
  streaming: false,
});
const projection = (items: readonly OrchestrationV2TurnItem[]): GroupRunProjection => ({
  deliveryId: "delivery",
  memberId: "member",
  environmentId: EnvironmentId.make("actual-member-environment"),
  threadId: sourceThreadId,
  runId,
  items,
  runtimeRequests: [],
  deferredItems: [],
  hasMoreItems: false,
  beforeOrdinal: null,
});

it("maps only the delivered run with genuine source identity and excludes its private bootstrap", () => {
  const message = item("answer", 2);
  const rows = groupRunRows(
    projection([
      { ...message, threadId: ThreadId.make("private-other-thread") },
      { ...message, runId: RunId.make("private-other-run") },
      {
        ...item("bootstrap", 1),
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments: [],
      },
      message,
    ]),
  );
  expect(rows).toEqual([
    { position: 2, visibility: "local", sourceThreadId, sourceItemId: message.id, item: message },
  ]);
});

it("merges earlier pages without regressing live items and rejects another delivery", () => {
  const live = projection([
    {
      ...item("answer", 2),
      text: "Live answer",
      updatedAt: DateTime.makeUnsafe("2026-10-29T10:00:01.000Z"),
    },
  ]);
  const older = {
    ...projection([item("older", 1), item("answer", 2)]),
    hasMoreItems: true,
    beforeOrdinal: 1,
  };
  const merged = mergeGroupRunProjections(live, older, true);
  expect(merged.items.map((entry) => ("text" in entry ? entry.text : entry.type))).toEqual([
    "older",
    "Live answer",
  ]);
  expect(merged.beforeOrdinal).toBe(1);
  expect(() => mergeGroupRunProjections(live, { ...older, deliveryId: "other-delivery" })).toThrow(
    "different group run",
  );
});

it("prepends body ranges only against the matching revision and contiguous byte window", () => {
  const shortened = {
    ...item("answer", 2),
    text: "tail",
    bodyRange: {
      field: "text" as const,
      startByte: 4,
      endByte: 8,
      totalBytes: 8,
      revision: "revision",
    },
  };
  const page = { text: "head", range: { ...shortened.bodyRange, startByte: 0, endByte: 4 } };
  expect(prependGroupRunBody(shortened, page)).toMatchObject({
    text: "headtail",
    bodyRange: { startByte: 0 },
  });
  expect(
    prependGroupRunBody(shortened, { ...page, range: { ...page.range, revision: "stale" } }),
  ).toBe(shortened);
});

it("uses current response authority without restoring it from older history", () => {
  const allowed = { ...projection([item("answer", 2)]), canRespond: true };
  const revoked = { ...projection([item("answer", 2)]), canRespond: false };
  expect(mergeGroupRunProjections(allowed, revoked).canRespond).toBe(false);
  expect(mergeGroupRunProjections(revoked, allowed, true).canRespond).toBe(false);
});

it("offers missing runs newest first only while their original mine still belongs to the group", () => {
  const member = { id: "member", environmentId: null, threadId: sourceThreadId };
  const removed = { ...member, id: "removed" };
  const replaced = { ...member, id: "replaced" };
  const targets = groupRunTargets(
    {
      members: [member, { ...replaced, threadId: ThreadId.make("replacement-thread") }],
      rounds: [
        { members: [member], deliveries: [{ id: "older", memberId: member.id, runId }] },
        {
          members: [member, removed, replaced],
          deliveries: [
            { id: "newer", memberId: member.id, runId: RunId.make("newer-run") },
            { id: "not-started", memberId: member.id, runId: null },
            { id: "removed", memberId: removed.id, runId },
            { id: "replaced", memberId: replaced.id, runId },
          ],
        },
      ],
    },
    EnvironmentId.make("coordinator"),
  );
  expect(targets.map((target) => target.deliveryId)).toEqual(["newer", "older"]);
  expect(targets[0]?.environmentId).toBe("coordinator");
  expect(
    missingGroupRunTargets(targets, [{ ...projection([]), ...targets[0]! }]).map(
      (target) => target.deliveryId,
    ),
  ).toEqual(["older"]);
});

it("discards loaded pages after membership removal or source/run replacement", () => {
  const loaded = projection([]);
  expect(eligibleGroupRunProjections([], [loaded])).toEqual([]);
  expect(
    eligibleGroupRunProjections(
      [{ ...loaded, environmentId: EnvironmentId.make("other") }],
      [loaded],
    ),
  ).toEqual([]);
  expect(
    eligibleGroupRunProjections([{ ...loaded, runId: RunId.make("other") }], [loaded]),
  ).toEqual([]);
  expect(eligibleGroupRunProjections([loaded], [loaded])).toEqual([loaded]);
});
