import { expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { genericPushEvent } from "./MinesPushPublisher.ts";

const now = DateTime.makeUnsafe("2026-10-25T00:00:00Z");
const threadId = ThreadId.make("private-thread");
const runId = RunId.make("private-run");
function runEvent(status: OrchestrationV2RunStatus): OrchestrationV2DomainEvent {
  return {
    id: EventId.make("event"),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "private-model-selection",
      },
      providerThreadId: null,
      userMessageId: MessageId.make("private-message"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}
it("only classifies terminal runs and pending attention requests for generic push", () => {
  for (const status of [
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "cancelled",
    "interrupted",
    "rolled_back",
  ] as const)
    expect(genericPushEvent(runEvent(status))).toBeNull();
  expect(genericPushEvent(runEvent("completed"))?.kind).toBe("run-completed");
  expect(genericPushEvent(runEvent("failed"))?.kind).toBe("needs-attention");
  const pending: OrchestrationV2DomainEvent = {
    id: EventId.make("request-event"),
    type: "runtime-request.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: RuntimeRequestId.make("private-request"),
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    },
  };
  expect(genericPushEvent(pending)?.kind).toBe("needs-attention");
  expect(
    genericPushEvent({ ...pending, payload: { ...pending.payload, status: "resolved" } }),
  ).toBeNull();
  expect(JSON.stringify(genericPushEvent(runEvent("completed")))).not.toContain(
    "private-model-selection",
  );
});
