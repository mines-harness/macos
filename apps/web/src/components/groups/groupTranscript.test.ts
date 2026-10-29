import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  GroupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import { pruneGroupHistoryProjections, mergeGroupHistory } from "./groupMessageHistory";
import {
  groupTranscript,
  groupTranscriptSearch,
  mergeGroupRunProjections,
  selectGroupRunProjections,
  prependGroupItemBody,
  type GroupTranscriptSnapshot,
} from "./groupTranscript";

const at = "2026-10-29T00:00:00.000Z";
const environmentId = EnvironmentId.make("coordinator");
const remoteId = EnvironmentId.make("remote");
const groupId = GroupId.make("group");
const member = {
  id: "member",
  groupId,
  environmentId: remoteId,
  threadId: ThreadId.make("source-mine"),
  projectId: ProjectId.make("project"),
  alias: "Builder",
  role: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  joinedAt: at,
};
const snapshot = (changes: Partial<GroupTranscriptSnapshot> = {}): GroupTranscriptSnapshot => ({
  group: {
    id: groupId,
    name: "Team",
    workflow: "team",
    leadMemberId: member.id,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  },
  members: [member],
  messages: [],
  rounds: [],
  hasMoreMessages: false,
  ...changes,
});
const message = {
  id: "reply:delivery",
  groupId,
  roundId: "round",
  memberId: member.id,
  kind: "assistant" as const,
  text: "| Result | Value |\n|---|---|\n| Tests | Passed |\n\n```ts\nconst answer = 42;\n```\n\n[Docs](https://example.com)",
  createdAt: at,
  truncated: false,
};

describe("group transcript through the normal timeline", () => {
  it("keeps Markdown and streaming in normal assistant rows with the source mine identity", () => {
    const nativeId = MessageId.make("native-answer");
    const transcript = groupTranscript(
      environmentId,
      snapshot({ messages: [{ ...message, streaming: true, sourceMessageId: nativeId }] }),
    );
    const rows = deriveMessagesTimelineRows({
      timelineEntries: transcript.entries,
      isWorking: false,
      supportsConversationRollback: false,
      turnDiffSummaries: [],
    });
    expect(rows.find((row) => row.kind === "message")).toMatchObject({
      kind: "message",
      message: { role: "assistant", text: message.text, streaming: true },
    });
    expect(transcript.sources.get(message.id)).toEqual({
      authorLabel: "Builder",
      environmentId: remoteId,
      threadRef: { environmentId: remoteId, threadId: member.threadId },
      citationMessageId: nativeId,
    });
  });

  it("routes native run tools and assistant messages through normal timeline derivation without a duplicate flat reply", () => {
    const fixture = makeStreamingTimelineFixture();
    const runId = RunId.make("run-rich");
    const items = fixture.visibleTurnItems
      .map((row) => row.item)
      .filter((item) => item.type === "command_execution" || item.type === "assistant_message")
      .map((item) => ({ ...item, threadId: member.threadId, runId }));
    expect(items.some((item) => item.type === "command_execution")).toBe(true);
    const transcript = groupTranscript(
      environmentId,
      snapshot({
        messages: [message],
        runProjections: [
          {
            deliveryId: "delivery",
            memberId: member.id,
            environmentId: remoteId,
            threadId: member.threadId,
            runId,
            items,
            runtimeRequests: [],
            deferredItems: [],
            hasMoreItems: false,
            beforeOrdinal: null,
          },
        ],
      }),
    );
    expect(
      transcript.entries.some(
        (entry) => entry.kind === "work" && entry.entry.itemType === "command_execution",
      ),
    ).toBe(true);
    expect(transcript.entries.some((entry) => entry.id === message.id)).toBe(false);
    const assistant = transcript.entries.find(
      (entry) => entry.kind === "message" && entry.message.role === "assistant",
    );
    expect(assistant?.kind === "message" && assistant.projectedItem?.sourceThreadId).toBe(
      member.threadId,
    );
    expect(assistant && transcript.sources.get(assistant.id)).toMatchObject({
      authorLabel: "Builder",
      environmentId: remoteId,
      threadRef: { environmentId: remoteId, threadId: member.threadId },
    });
  });

  it("keeps a native visual bound to its exact source item for authorized asset loading", () => {
    const native = makeStreamingTimelineFixture().visibleTurnItems.find(
      (row) => row.item.type === "command_execution",
    )!.item;
    if (native.type !== "command_execution") throw new Error("Expected command fixture");
    const runId = RunId.make("visual-run");
    const reference = { attachmentId: "source-visual", title: "Result", height: 300 };
    const item = {
      ...native,
      type: "dynamic_tool" as const,
      threadId: member.threadId,
      runId,
      status: "completed" as const,
      toolName: "html_render",
      input: {},
      output: { htmlRender: reference },
    };
    const transcript = groupTranscript(
      environmentId,
      snapshot({
        runProjections: [
          {
            deliveryId: "visual",
            memberId: member.id,
            environmentId: remoteId,
            threadId: member.threadId,
            runId,
            items: [item],
            runtimeRequests: [],
            deferredItems: [],
            hasMoreItems: false,
            beforeOrdinal: null,
          },
        ],
      }),
    );
    const visual = transcript.entries.find((entry) => entry.kind === "html-render");
    expect(visual).toMatchObject({ kind: "html-render", id: item.id, htmlRender: reference });
    expect(visual && transcript.sources.get(visual.id)).toMatchObject({
      deliveryId: "visual",
      environmentId: remoteId,
      projectedItem: { sourceItemId: item.id, sourceThreadId: member.threadId },
    });
  });

  it("preserves the actual sender and files/context for human group messages", () => {
    const attachment = {
      id: "image",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const context = { version: 1 as const, records: [] };
    const transcript = groupTranscript(
      environmentId,
      snapshot({
        messages: [
          {
            ...message,
            kind: "user",
            memberId: null,
            authorFriendId: "friend",
            attachments: [attachment],
            context,
          },
        ],
      }),
      new Map([["friend", "Sam"]]),
    );
    expect(transcript.entries[0]).toMatchObject({
      kind: "message",
      message: { role: "user", attachments: [attachment], context },
    });
    expect(transcript.sources.get(message.id)).toEqual({
      authorLabel: "Sam",
      environmentId,
      threadRef: null,
      citationMessageId: null,
    });
  });

  it("retains historical mine identity after it leaves and only marks active deliveries streaming", () => {
    const round = {
      id: "round",
      groupId,
      userMessageId: "prompt",
      routing: "everyone" as const,
      workflow: "team" as const,
      status: "active" as const,
      members: [member],
      deliveries: [
        {
          id: "delivery",
          memberId: member.id,
          stage: "initial" as const,
          status: "running" as const,
          runId: RunId.make("native-run"),
          hop: 0,
          parentDeliveryId: null,
          request: "Review",
          contextThroughMessageId: null,
          error: null,
        },
      ],
      createdAt: at,
      completedAt: null,
    };
    const active = groupTranscript(
      environmentId,
      snapshot({ members: [], messages: [message], rounds: [round] }),
    );
    expect(active.entries[0]).toMatchObject({ message: { streaming: true, runId: "native-run" } });
    expect(active.sources.get(message.id)?.authorLabel).toBe("Builder");
    const done = groupTranscript(
      environmentId,
      snapshot({ messages: [message], rounds: [{ ...round, status: "completed" }] }),
    );
    expect(done.entries[0]).toMatchObject({ message: { streaming: false } });
    expect(done.sources.get(message.id)?.citationMessageId).toBeNull();
  });

  it("searches the rendered Markdown segments using the same matching as normal conversations", () => {
    const transcript = groupTranscript(
      environmentId,
      snapshot({ messages: [message, { ...message, id: "second", text: "**Passed** again" }] }),
    );
    const result = groupTranscriptSearch(transcript.entries, "passed");
    expect(result.total).toBe(2);
    expect(
      result.navigation.map((entry) => ({
        entryId: entry.entryId,
        start: entry.start,
        count: entry.count,
      })),
    ).toEqual([
      { entryId: message.id, start: 0, count: 1 },
      { entryId: "second", start: 1, count: 1 },
    ]);
    expect(groupTranscriptSearch(transcript.entries, "const answer = 42").total).toBe(1);
    expect(groupTranscriptSearch(transcript.entries, "https://example.com").total).toBe(0);
  });
});

it("expands native message bodies only across the exact revision and byte boundary", () => {
  const native = makeStreamingTimelineFixture().visibleTurnItems.find(
    (row) => row.item.type === "assistant_message",
  )!.item;
  if (native.type !== "assistant_message") throw new Error("Expected assistant fixture");
  const range = {
    field: "text" as const,
    startByte: 5,
    endByte: 9,
    totalBytes: 9,
    revision: "same",
  };
  const item = { ...native, text: "tail", bodyRange: range };
  const page = { text: "head ", range: { ...range, startByte: 0, endByte: 5 } };
  expect(prependGroupItemBody(item, page)).toMatchObject({
    text: "head tail",
    bodyRange: { startByte: 0 },
  });
  expect(prependGroupItemBody(item, { ...page, range: { ...page.range, revision: "stale" } })).toBe(
    item,
  );
  expect(prependGroupItemBody(item, { ...page, range: { ...page.range, endByte: 4 } })).toBe(item);
  expect(item.text).toBe("tail");
});

it("merges older native pages without losing expanded bodies or retaining revoked run projections", () => {
  const native = makeStreamingTimelineFixture().visibleTurnItems.find(
    (row) => row.item.type === "assistant_message",
  )!.item;
  if (native.type !== "assistant_message") throw new Error("Expected assistant fixture");
  const projection = {
    deliveryId: "delivery",
    memberId: member.id,
    environmentId: remoteId,
    threadId: member.threadId,
    runId: RunId.make("run"),
    items: [
      {
        ...native,
        text: "tail",
        bodyRange: {
          field: "text" as const,
          startByte: 5,
          endByte: 9,
          totalBytes: 9,
          revision: "same",
        },
      },
    ],
    runtimeRequests: [],
    deferredItems: [],
    hasMoreItems: true,
    beforeOrdinal: 4,
  };
  const expanded = {
    ...projection,
    items: [
      {
        ...projection.items[0]!,
        text: "head tail",
        bodyRange: { ...projection.items[0]!.bodyRange, startByte: 0 },
      },
    ],
  };
  expect(mergeGroupRunProjections([projection], [expanded])[0]?.items[0]).toMatchObject({
    text: "head tail",
    bodyRange: { startByte: 0 },
  });
  const changed = {
    ...projection,
    items: [
      {
        ...projection.items[0]!,
        text: "new",
        bodyRange: { ...projection.items[0]!.bodyRange, revision: "new" },
      },
    ],
  };
  expect(mergeGroupRunProjections([changed], [expanded])[0]?.items[0]).toMatchObject({
    text: "new",
  });
  expect(mergeGroupRunProjections([], [expanded])).toEqual([]);
  expect(
    mergeGroupRunProjections([projection], [{ ...expanded, runId: RunId.make("other") }])[0],
  ).toBe(projection);
});

it("refreshes a deferred live item when its final public revision arrives", () => {
  const native = makeStreamingTimelineFixture().visibleTurnItems.find(
    (row) => row.item.type === "assistant_message",
  )!.item;
  const done = { ...native, status: "completed" as const };
  const live = { ...native, status: "running" as const };
  const projection = {
    deliveryId: "delivery",
    memberId: member.id,
    environmentId: remoteId,
    threadId: member.threadId,
    runId: RunId.make("run"),
    items: [],
    runtimeRequests: [],
    deferredItems: [{ id: done.id, ordinal: done.ordinal, revision: turnItemDetailRevision(done) }],
    hasMoreItems: false,
    beforeOrdinal: null,
  };
  const cachedLive = { ...projection, items: [live], deferredItems: [] };
  const waiting = mergeGroupRunProjections([projection], [cachedLive])[0];
  expect(waiting?.items).toEqual([]);
  expect(waiting?.deferredItems).toHaveLength(1);
  const cachedDone = { ...projection, items: [done], deferredItems: [] };
  const finished = mergeGroupRunProjections([projection], [cachedLive, cachedDone])[0];
  expect(finished?.items).toEqual([done]);
  expect(finished?.deferredItems).toEqual([]);
});

it("offers missing runs in recent order and retains explicitly loaded activity only for its current member identity", () => {
  const runId = RunId.make("older-run");
  const delivery = {
    id: "older-delivery",
    memberId: member.id,
    stage: "initial" as const,
    status: "completed" as const,
    runId,
    hop: 0,
    parentDeliveryId: null,
    request: "",
    contextThroughMessageId: null,
    error: null,
  };
  const round = {
    id: "round",
    groupId,
    userMessageId: "question",
    routing: "everyone" as const,
    workflow: "team" as const,
    status: "completed" as const,
    members: [member],
    deliveries: [delivery, { ...delivery, id: "recent-delivery", runId: RunId.make("recent-run") }],
    createdAt: at,
    completedAt: at,
  };
  const live = snapshot({ rounds: [round] });
  expect(
    selectGroupRunProjections(live, [], environmentId).missing.map((run) => run.deliveryId),
  ).toEqual(["recent-delivery", "older-delivery"]);
  const loaded = {
    deliveryId: delivery.id,
    memberId: member.id,
    environmentId: remoteId,
    threadId: member.threadId,
    runId,
    items: [],
    runtimeRequests: [],
    deferredItems: [],
    hasMoreItems: false,
    beforeOrdinal: null,
  };
  const selection = selectGroupRunProjections(live, [loaded], environmentId);
  expect(selection.projections).toEqual([loaded]);
  expect(selection.missing.map((run) => run.deliveryId)).toEqual(["recent-delivery"]);
  const page = { ...live, messages: [message], runProjections: [loaded] };
  const pruned = pruneGroupHistoryProjections({ ...live, members: [] }, [page]);
  expect(pruned[0]?.runProjections).toEqual([]);
  expect(pruned[0]?.messages).toEqual([message]);
  expect(mergeGroupHistory(live, pruned).runProjections ?? []).toEqual([]);
  const removed = selectGroupRunProjections({ ...live, members: [] }, [loaded], environmentId);
  expect(removed.projections).toEqual([]);
  expect(removed.loaded).toEqual([]);
  expect(removed.missing).toEqual([]);
  expect(
    selectGroupRunProjections(
      { ...live, members: [{ ...member, threadId: ThreadId.make("replacement") }] },
      [loaded],
      environmentId,
    ).loaded,
  ).toEqual([]);
  expect(
    selectGroupRunProjections(
      { ...live, members: [{ ...member, environmentId }] },
      [loaded],
      environmentId,
    ).loaded,
  ).toEqual([]);
  expect(
    selectGroupRunProjections(
      {
        ...live,
        rounds: [{ ...round, deliveries: [{ ...delivery, runId: RunId.make("replacement") }] }],
      },
      [loaded],
      environmentId,
    ).loaded,
  ).toEqual([]);
});

it("keeps a loaded native assistant row synchronized with the latest group reply without losing its native identity", () => {
  const native = makeStreamingTimelineFixture().visibleTurnItems.find(
    (row) => row.item.type === "assistant_message",
  )!.item;
  if (native.type !== "assistant_message") throw new Error("Expected assistant fixture");
  const projection = {
    deliveryId: "delivery",
    memberId: member.id,
    environmentId: remoteId,
    threadId: member.threadId,
    runId: native.runId!,
    items: [{ ...native, text: "earlier", streaming: true }],
    runtimeRequests: [],
    deferredItems: [],
    hasMoreItems: false,
    beforeOrdinal: null,
  };
  const live = {
    ...message,
    sourceMessageId: native.messageId,
    sourceRunId: native.runId!,
    text: "Latest streamed answer",
    streaming: true,
  };
  const transcript = groupTranscript(
    environmentId,
    snapshot({ messages: [live], runProjections: [projection] }),
  );
  expect(transcript.entries.filter((entry) => entry.kind === "message")).toHaveLength(1);
  expect(transcript.entries.find((entry) => entry.kind === "message")).toMatchObject({
    message: { id: native.messageId, text: live.text, streaming: true },
  });
  const completed = groupTranscript(
    environmentId,
    snapshot({
      messages: [{ ...live, text: "Final answer", streaming: false }],
      runProjections: [projection],
    }),
  );
  expect(completed.entries.find((entry) => entry.kind === "message")).toMatchObject({
    message: { text: "Final answer", streaming: false },
  });
  const pending = groupTranscript(
    environmentId,
    snapshot({
      messages: [live],
      runProjections: [
        {
          ...projection,
          items: [],
          deferredItems: [
            { id: native.id, ordinal: native.ordinal, revision: turnItemDetailRevision(native) },
          ],
        },
      ],
    }),
  );
  expect(pending.entries.find((entry) => entry.kind === "message")).toMatchObject({
    message: { text: live.text },
  });
});
