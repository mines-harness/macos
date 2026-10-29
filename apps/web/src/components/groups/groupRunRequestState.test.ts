import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  TurnItemId,
  NodeId,
  RuntimeRequestId,
  ProviderSessionId,
  type GroupRunProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { groupRunRequests } from "./groupRunRequestState";

function fixture(): GroupRunProjection {
  const at = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
  const requestId = RuntimeRequestId.make("approval");
  const threadId = ThreadId.make("actual-mine");
  const runId = RunId.make("actual-run");
  const nodeId = NodeId.make("actual-node");
  return {
    deliveryId: "delivery",
    memberId: "member",
    environmentId: EnvironmentId.make("owner"),
    threadId,
    runId,
    canRespond: true,
    items: [
      {
        id: TurnItemId.make("approval-item"),
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "pending",
        title: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "git status",
        options: [
          { decision: "accept", label: "Approve" },
          { decision: "decline", label: "Decline" },
        ],
      },
    ],
    runtimeRequests: [
      {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("live-session"),
        },
        createdAt: at,
        resolvedAt: null,
      },
    ],
    deferredItems: [],
    hasMoreItems: false,
    beforeOrdinal: null,
  };
}

it("uses normal request details while requiring an explicit contributor response grant", () => {
  const projection = fixture();
  const requestId = projection.runtimeRequests[0]!.id;
  expect(groupRunRequests(projection).approvals[0]?.detail).toBe("git status");
  expect(groupRunRequests(projection).canRespond(requestId)).toBe(true);
  expect(groupRunRequests({ ...projection, canRespond: false }).canRespond(requestId)).toBe(false);
  const { canRespond: _grant, ...olderProjection } = projection;
  expect(groupRunRequests(olderProjection).canRespond(requestId)).toBe(false);
});

it("cannot approve a deferred request until its complete details have been loaded", () => {
  const projection = fixture();
  const requestId = projection.runtimeRequests[0]!.id;
  const state = groupRunRequests({
    ...projection,
    items: [],
    deferredItems: [{ id: projection.items[0]!.id, ordinal: 1, revision: "revision" }],
  });
  expect(state.incomplete.map((request) => request.id)).toEqual([requestId]);
  expect(state.canRespond(requestId)).toBe(false);
});

it("stops offering resolved and no-longer-resumable provider requests", () => {
  const projection = fixture();
  const request = projection.runtimeRequests[0]!;
  const resolved = groupRunRequests({
    ...projection,
    runtimeRequests: [{ ...request, status: "resolved" }],
  });
  expect(resolved.approvals).toEqual([]);
  expect(resolved.canRespond(request.id)).toBe(false);
  expect(
    groupRunRequests({
      ...projection,
      runtimeRequests: [
        { ...request, responseCapability: { type: "not_resumable", reason: "Stopped" } },
      ],
    }).canRespond(request.id),
  ).toBe(false);
});
