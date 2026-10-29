import type { GroupMessage, GroupRunProjection } from "@t3tools/contracts/groupChat";

type MessageSource = Pick<GroupMessage, "id" | "kind" | "memberId" | "sourceRunId">;

export function groupMessageProjection(
  projections: readonly GroupRunProjection[] | undefined,
  message: MessageSource,
) {
  if (message.kind !== "assistant" && message.kind !== "handoff") return undefined;
  return projections?.find(
    (projection) =>
      projection.memberId === message.memberId &&
      projection.items.some(
        (item) =>
          item.threadId === projection.threadId &&
          item.runId === projection.runId &&
          item.type !== "user_message",
      ) &&
      (message.sourceRunId === undefined
        ? message.id === `reply:${projection.deliveryId}`
        : message.sourceRunId === projection.runId),
  );
}

export function unplacedGroupProjections(
  projections: readonly GroupRunProjection[] | undefined,
  messages: readonly MessageSource[],
) {
  const placed = new Set(
    messages.flatMap((message) => {
      const projection = groupMessageProjection(projections, message);
      return projection ? [projection.deliveryId] : [];
    }),
  );
  return (projections ?? []).filter(
    (projection) =>
      !placed.has(projection.deliveryId) &&
      (projection.items.length > 0 ||
        projection.deferredItems.length > 0 ||
        projection.runtimeRequests.length > 0 ||
        projection.hasMoreItems),
  );
}
