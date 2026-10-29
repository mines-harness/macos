import type {
  OrchestrationV2BodyRangeResult,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  EnvironmentId,
} from "@t3tools/contracts";
import type { GroupDelivery, GroupMember, GroupRunProjection } from "@t3tools/contracts/groupChat";
import * as DateTime from "effect/DateTime";

type RunMember = Pick<GroupMember, "id" | "environmentId" | "threadId">;
export type GroupRunTarget = Pick<
  GroupRunProjection,
  "deliveryId" | "memberId" | "environmentId" | "threadId" | "runId"
>;

export function groupRunTargets(
  snapshot:
    | {
        readonly members: readonly RunMember[];
        readonly rounds: readonly {
          readonly members: readonly RunMember[];
          readonly deliveries: readonly Pick<GroupDelivery, "id" | "memberId" | "runId">[];
        }[];
      }
    | null
    | undefined,
  coordinatorEnvironmentId: EnvironmentId,
): GroupRunTarget[] {
  if (!snapshot) return [];
  const members = new Map(snapshot.members.map((member) => [member.id, member]));
  const targets = new Map<string, GroupRunTarget>();
  for (const round of [...snapshot.rounds].reverse()) {
    for (const delivery of [...round.deliveries].reverse()) {
      if (!delivery.runId || targets.has(delivery.id)) continue;
      const original = round.members.find((member) => member.id === delivery.memberId);
      const current = members.get(delivery.memberId);
      if (
        !original ||
        !current ||
        original.environmentId !== current.environmentId ||
        original.threadId !== current.threadId
      )
        continue;
      targets.set(delivery.id, {
        deliveryId: delivery.id,
        memberId: original.id,
        environmentId: original.environmentId ?? coordinatorEnvironmentId,
        threadId: original.threadId,
        runId: delivery.runId,
      });
    }
  }
  return [...targets.values()];
}

export function groupRunTargetKey(target: GroupRunTarget) {
  return JSON.stringify([
    target.deliveryId,
    target.memberId,
    target.environmentId,
    target.threadId,
    target.runId,
  ]);
}

export function eligibleGroupRunProjections(
  targets: readonly GroupRunTarget[],
  projections: readonly GroupRunProjection[],
) {
  const eligible = new Set(targets.map(groupRunTargetKey));
  return projections.filter((projection) => eligible.has(groupRunTargetKey(projection)));
}

export function missingGroupRunTargets(
  targets: readonly GroupRunTarget[],
  projections: readonly GroupRunProjection[],
) {
  const loaded = new Set(projections.map(groupRunTargetKey));
  return targets.filter((target) => !loaded.has(groupRunTargetKey(target)));
}

export function groupRunRows(projection: GroupRunProjection): OrchestrationV2ProjectedTurnItem[] {
  return projection.items
    .filter(
      (item) =>
        item.threadId === projection.threadId &&
        item.runId === projection.runId &&
        item.type !== "user_message",
    )
    .map((item) => ({
      position: item.ordinal,
      visibility: "local",
      sourceThreadId: projection.threadId,
      sourceItemId: item.id,
      item,
    }));
}

export function mergeGroupRunProjections(
  current: GroupRunProjection,
  next: GroupRunProjection,
  olderPage = false,
): GroupRunProjection {
  if (
    current.deliveryId !== next.deliveryId ||
    current.memberId !== next.memberId ||
    current.threadId !== next.threadId ||
    current.environmentId !== next.environmentId ||
    current.runId !== next.runId
  )
    throw new Error("Cannot merge a different group run.");
  const items = new Map(current.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    const existing = items.get(item.id);
    if (
      !existing ||
      DateTime.toEpochMillis(existing.updatedAt) < DateTime.toEpochMillis(item.updatedAt) ||
      (DateTime.toEpochMillis(existing.updatedAt) === DateTime.toEpochMillis(item.updatedAt) &&
        existing.bodyRange?.revision === item.bodyRange?.revision &&
        (existing.bodyRange?.startByte ?? 0) >= (item.bodyRange?.startByte ?? 0))
    )
      items.set(item.id, item);
  }
  const requests = new Map(current.runtimeRequests.map((request) => [request.id, request]));
  for (const request of next.runtimeRequests) {
    const existing = requests.get(request.id);
    if (!existing || request.status !== "pending" || existing.status === "pending")
      requests.set(request.id, request);
  }
  const deferred = new Map(
    [...current.deferredItems, ...next.deferredItems].map((item) => [item.id, item]),
  );
  return {
    ...current,
    items: [...items.values()].sort((a, b) => a.ordinal - b.ordinal),
    runtimeRequests: [...requests.values()],
    deferredItems: [...deferred.values()]
      .filter((item) => !items.has(item.id))
      .sort((a, b) => a.ordinal - b.ordinal),
    ...(olderPage
      ? { hasMoreItems: next.hasMoreItems, beforeOrdinal: next.beforeOrdinal }
      : { canRespond: next.canRespond === true }),
  };
}

export function prependGroupRunBody(
  item: OrchestrationV2TurnItem,
  page: OrchestrationV2BodyRangeResult,
): OrchestrationV2TurnItem {
  const range = item.bodyRange;
  if (
    !range ||
    range.revision !== page.range.revision ||
    range.field !== page.range.field ||
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
