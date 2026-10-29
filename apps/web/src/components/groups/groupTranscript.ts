import {
  MessageId,
  type EnvironmentId,
  type GroupSnapshot,
  type GroupRunProjection,
  type OrchestrationV2BodyRangeResult,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import type { ThreadFindMatch } from "../chat/threadFind";

export type GroupTranscriptSnapshot = GroupSnapshot;

export interface GroupTranscriptSource {
  readonly authorLabel: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly citationMessageId: MessageId | null;
  readonly deliveryId?: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
  readonly messageTruncated?: true;
}

export function groupTranscript(
  environmentId: EnvironmentId,
  snapshot: GroupTranscriptSnapshot,
  authorNames: ReadonlyMap<string, string> = new Map(),
  coordinatorEnvironmentId: EnvironmentId = environmentId,
): {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly sources: ReadonlyMap<string, GroupTranscriptSource>;
} {
  const sources = new Map<string, GroupTranscriptSource>();
  const projections = snapshot.runProjections ?? [];
  const richDeliveryIds = new Set(
    projections
      .filter((projection) => projection.items.some((item) => item.type === "assistant_message"))
      .map((projection) => `reply:${projection.deliveryId}`),
  );
  const entries: TimelineEntry[] = snapshot.messages
    .filter((message) => !richDeliveryIds.has(message.id))
    .map((message): TimelineEntry => {
      const round = snapshot.rounds.find((candidate) => candidate.id === message.roundId);
      const member =
        round?.members.find((candidate) => candidate.id === message.memberId) ??
        snapshot.members.find((candidate) => candidate.id === message.memberId);
      const delivery = round?.deliveries.find(
        (candidate) => `reply:${candidate.id}` === message.id,
      );
      const sourceEnvironment = member
        ? (member.environmentId ?? coordinatorEnvironmentId)
        : environmentId;
      sources.set(message.id, {
        authorLabel: member
          ? member.alias
          : message.memberId !== null
            ? "Former mine"
            : message.authorFriendId !== undefined
              ? (authorNames.get(message.authorFriendId) ?? "User")
              : message.kind === "user"
                ? "You"
                : "Group",
        environmentId: sourceEnvironment,
        threadRef: member ? { environmentId: sourceEnvironment, threadId: member.threadId } : null,
        citationMessageId: message.sourceMessageId ?? null,
      });
      return {
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message: {
          id: MessageId.make(message.id),
          role:
            message.kind === "assistant"
              ? "assistant"
              : message.kind === "user"
                ? "user"
                : "system",
          text: message.text,
          attachments: message.attachments ?? [],
          ...(message.context ? { context: message.context } : {}),
          runId: message.sourceRunId ?? delivery?.runId ?? null,
          streaming:
            message.streaming ??
            (message.kind === "assistant" &&
              round?.status === "active" &&
              (delivery?.status === "running" || delivery?.status === "queued")),
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        },
      };
    });
  for (const projection of projections) {
    const reply = snapshot.messages.find(
      (message) => message.id === `reply:${projection.deliveryId}`,
    );
    const round = snapshot.rounds.find((candidate) =>
      candidate.deliveries.some((delivery) => delivery.id === projection.deliveryId),
    );
    const member =
      round?.members.find((candidate) => candidate.id === projection.memberId) ??
      snapshot.members.find((candidate) => candidate.id === projection.memberId);
    const projectedItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = projection.items.map(
      (sourceItem) => {
        const syncReply =
          sourceItem.type === "assistant_message" &&
          reply?.sourceMessageId === sourceItem.messageId &&
          (!reply.truncated || reply.streaming);
        const { bodyRange: _range, ...withoutRange } = sourceItem;
        const item = syncReply
          ? {
              ...withoutRange,
              text: reply.text,
              streaming: reply.streaming ?? false,
              ...(reply.attachments ? { attachments: reply.attachments } : {}),
            }
          : sourceItem;
        return {
          position: item.ordinal,
          visibility: "local",
          sourceThreadId: projection.threadId,
          sourceItemId: item.id,
          item,
        };
      },
    );
    const nativeEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: projectedItems,
      optimisticMessages: [],
    });
    const baseSource = {
      authorLabel: member?.alias ?? "Former mine",
      environmentId: projection.environmentId,
      threadRef: { environmentId: projection.environmentId, threadId: projection.threadId },
      citationMessageId: null,
      deliveryId: projection.deliveryId,
    };
    sources.set(`run:${projection.runId}`, baseSource);
    for (const entry of nativeEntries) {
      const projectedItem =
        entry.kind === "message" || entry.kind === "event"
          ? entry.projectedItem
          : entry.kind === "work"
            ? entry.entry.projectedItem
            : entry.kind === "proposed-plan"
              ? projectedItems.find(
                  (row) =>
                    row.item.type === "proposed_plan" && row.item.planId === entry.proposedPlan.id,
                )
              : projectedItems.find((row) => row.sourceItemId === entry.id);
      sources.set(entry.id, {
        ...baseSource,
        citationMessageId:
          entry.kind === "message" && entry.message.role === "assistant" ? entry.message.id : null,
        ...(projectedItem ? { projectedItem } : {}),
        ...(entry.kind === "message" &&
        reply?.truncated &&
        reply.sourceMessageId === entry.message.id
          ? { messageTruncated: true as const }
          : {}),
      });
      if (entry.kind === "message") sources.set(entry.message.id, sources.get(entry.id)!);
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { entries, sources };
}

export function groupTranscriptSearch(entries: ReadonlyArray<TimelineEntry>, query: string) {
  const normalized = query.trim();
  let total = 0;
  const navigation: Array<ThreadFindMatch & { readonly start: number; readonly count: number }> =
    [];
  if (!normalized) return { total, navigation };
  for (const entry of entries) {
    const segments =
      entry.kind === "message" && entry.message.role !== "system"
        ? searchableMessageSegments({ ...entry.message, role: entry.message.role })
        : entry.kind === "proposed-plan"
          ? searchablePlanSegments(entry.proposedPlan.planMarkdown)
          : null;
    const count =
      segments?.reduce((sum, text) => sum + countThreadSearchOccurrences(text, normalized), 0) ?? 0;
    if (count === 0) continue;
    navigation.push({
      entryId: entry.id,
      runId: entry.kind === "message" ? entry.message.runId : null,
      occurrence: 0,
      start: total,
      count,
    });
    total += count;
  }
  return { total, navigation };
}

export function prependGroupItemBody(
  item: OrchestrationV2TurnItem,
  page: OrchestrationV2BodyRangeResult,
): OrchestrationV2TurnItem {
  const range = item.bodyRange;
  if (
    !range ||
    range.field !== page.range.field ||
    range.revision !== page.range.revision ||
    range.startByte !== page.range.endByte
  )
    return item;
  const bodyRange = { ...range, startByte: page.range.startByte };
  return range.field === "text" && "text" in item
    ? { ...item, text: page.text + item.text, bodyRange }
    : range.field === "markdown" && "markdown" in item
      ? { ...item, markdown: page.text + item.markdown, bodyRange }
      : item;
}

export function mergeGroupRunProjections(
  current: ReadonlyArray<GroupRunProjection>,
  loaded: ReadonlyArray<GroupRunProjection>,
): ReadonlyArray<GroupRunProjection> {
  return current.map((projection) => {
    const pages = loaded.filter(
      (page) =>
        page.deliveryId === projection.deliveryId &&
        page.runId === projection.runId &&
        page.threadId === projection.threadId &&
        page.environmentId === projection.environmentId,
    );
    if (pages.length === 0) return projection;
    const items = new Map(
      pages.flatMap((page) => page.items.map((item) => [item.id, item] as const)),
    );
    for (const item of projection.items) {
      const cached = items.get(item.id);
      const keepExpanded =
        cached?.bodyRange &&
        item.bodyRange &&
        cached.bodyRange.revision === item.bodyRange.revision &&
        cached.bodyRange.endByte === item.bodyRange.endByte &&
        cached.bodyRange.startByte < item.bodyRange.startByte;
      if (!keepExpanded) items.set(item.id, item);
    }
    for (const reference of projection.deferredItems) {
      const cached = items.get(reference.id);
      if (cached && turnItemDetailRevision(cached) !== reference.revision)
        items.delete(reference.id);
    }
    const deferred = new Map(
      [...pages, projection].flatMap((page) =>
        page.deferredItems.map((item) => [item.id, item] as const),
      ),
    );
    for (const id of items.keys()) deferred.delete(id);
    const earliest = pages.reduce(
      (oldest, page) =>
        page.beforeOrdinal !== null &&
        (oldest.beforeOrdinal === null || page.beforeOrdinal < oldest.beforeOrdinal)
          ? page
          : oldest,
      projection,
    );
    return {
      ...projection,
      items: [...items.values()].sort((left, right) => left.ordinal - right.ordinal),
      deferredItems: [...deferred.values()].sort((left, right) => left.ordinal - right.ordinal),
      hasMoreItems: pages.some((page) => !page.hasMoreItems) ? false : earliest.hasMoreItems,
      beforeOrdinal: earliest.beforeOrdinal,
    };
  });
}

export function selectGroupRunProjections(
  snapshot: GroupTranscriptSnapshot,
  loaded: ReadonlyArray<GroupRunProjection>,
  coordinatorEnvironmentId: EnvironmentId,
) {
  const targets = snapshot.rounds.toReversed().flatMap((round) =>
    round.deliveries.toReversed().flatMap((delivery) => {
      const member = snapshot.members.find((member) => member.id === delivery.memberId);
      const original = round.members.find((member) => member.id === delivery.memberId);
      if (
        !delivery.runId ||
        !member ||
        !original ||
        member.threadId !== original.threadId ||
        (member.environmentId ?? coordinatorEnvironmentId) !==
          (original.environmentId ?? coordinatorEnvironmentId)
      )
        return [];
      return [
        {
          deliveryId: delivery.id,
          memberId: member.id,
          environmentId: member.environmentId ?? coordinatorEnvironmentId,
          threadId: member.threadId,
          runId: delivery.runId,
        },
      ];
    }),
  );
  const matches = (target: (typeof targets)[number], projection: GroupRunProjection) =>
    target.deliveryId === projection.deliveryId &&
    target.memberId === projection.memberId &&
    target.environmentId === projection.environmentId &&
    target.threadId === projection.threadId &&
    target.runId === projection.runId;
  const permitted = loaded.filter((projection) =>
    targets.some((target) => matches(target, projection)),
  );
  const base = (snapshot.runProjections ?? []).filter((projection) =>
    targets.some((target) => matches(target, projection)),
  );
  for (const projection of permitted) {
    if (!base.some((current) => matches(current, projection))) base.push(projection);
  }
  return {
    loaded: permitted,
    projections: mergeGroupRunProjections(base, permitted),
    missing: targets.filter((target) => !base.some((projection) => matches(target, projection))),
  };
}
