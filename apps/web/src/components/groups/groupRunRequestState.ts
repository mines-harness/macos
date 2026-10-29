import type { GroupRunProjection, RuntimeRequestId } from "@t3tools/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";

export function groupRunRequests(projection: GroupRunProjection) {
  const pending = derivePendingThreadRequests({
    turnItems: projection.items,
    runtimeRequests: projection.runtimeRequests,
  });
  const detailed = new Set(
    projection.items.flatMap((item) =>
      item.type === "approval_request" || item.type === "user_input_request"
        ? [item.requestId]
        : [],
    ),
  );
  return {
    approvals: derivePendingApprovals(pending.approvals),
    userInputs: derivePendingUserInputs(pending.userInputs),
    incomplete: projection.runtimeRequests.filter(
      (request) => request.status === "pending" && !detailed.has(request.id),
    ),
    canRespond: (requestId: RuntimeRequestId) =>
      projection.canRespond === true &&
      detailed.has(requestId) &&
      projection.runtimeRequests.some(
        (request) =>
          request.id === requestId &&
          request.status === "pending" &&
          request.responseCapability.type !== "not_resumable",
      ),
  };
}
