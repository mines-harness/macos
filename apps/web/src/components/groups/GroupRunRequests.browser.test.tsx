import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  TurnItemId,
  NodeId,
  RuntimeRequestId,
  ProviderSessionId,
  GroupId,
  type GroupRunProjection,
  type GroupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { render } from "../../../test/render";
import { useAtomCommand } from "../../state/use-atom-command";
import { GroupRunRequests } from "./GroupRunRequests";

vi.mock("./GroupMessageComposer", () => ({ GroupMessageComposer: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../state/groups", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { groupRespondToRuntimeRequest: { permissionAtom: () => allowed } };
});
vi.mock("../../state/sharedGroups", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return { sharedGroupRespondToRuntimeRequest: { permissionAtom: () => allowed } };
});

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

function snapshot(projection: GroupRunProjection): GroupSnapshot {
  const groupId = GroupId.make("group");
  return {
    group: {
      id: groupId,
      name: "Team",
      workflow: "team",
      leadMemberId: "member",
      createdAt: "2026-10-29T00:00:00Z",
      updatedAt: "2026-10-29T00:00:00Z",
      archivedAt: null,
    },
    members: [],
    rounds: [],
    messages: [],
    hasMoreMessages: false,
    runProjections: [projection],
  };
}

it("routes approval through the exact group delivery and runtime request", async () => {
  const projection = fixture();
  const run = vi.fn(async () => AsyncResult.success(undefined));
  vi.mocked(useAtomCommand).mockReturnValue(run);
  await using screen = await render(
    <GroupRunRequests environmentId={projection.environmentId} snapshot={snapshot(projection)} />,
  );
  await expect.element(screen.getByText("git status", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      environmentId: projection.environmentId,
      input: expect.objectContaining({
        groupId: "group",
        deliveryId: projection.deliveryId,
        requestId: projection.runtimeRequests[0]!.id,
        decision: "accept",
        clientRequestId: expect.any(String),
      }),
    }),
  );
});

it("shows other contributors’ approvals without granting response actions", async () => {
  const projection = { ...fixture(), canRespond: false };
  const run = vi.fn(async () => AsyncResult.success(undefined));
  vi.mocked(useAtomCommand).mockReturnValue(run);
  await using screen = await render(
    <GroupRunRequests environmentId={projection.environmentId} snapshot={snapshot(projection)} />,
  );
  await expect.element(screen.getByText("git status", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  expect(run).not.toHaveBeenCalled();
});

it("answers a mine’s multiple-choice question through its exact shared delivery", async () => {
  const source = fixture();
  const item = source.items[0]!;
  if (item.type !== "approval_request") throw new Error("Missing approval fixture");
  const request = source.runtimeRequests[0]!;
  const projection: GroupRunProjection = {
    ...source,
    items: [
      {
        ...item,
        type: "user_input_request",
        requestId: request.id,
        questions: [
          {
            id: "platforms",
            header: "Platforms",
            question: "Which platforms should this include?",
            multiSelect: true,
            allowCustomAnswer: false,
            options: [
              { label: "macOS", description: "Apple desktop app", value: "mac" },
              { label: "Windows", description: "Windows desktop app", value: "win" },
            ],
          },
        ],
      },
    ],
    runtimeRequests: [{ ...request, kind: "user_input" }],
  };
  const address = { groupKey: "shared-group", coordinatorDeviceId: "coordinator" };
  const run = vi.fn(async () => AsyncResult.success(undefined));
  vi.mocked(useAtomCommand).mockReturnValue(run);
  await using screen = await render(
    <GroupRunRequests
      environmentId={projection.environmentId}
      snapshot={snapshot(projection)}
      sharedAddress={address}
    />,
  );
  await screen.getByRole("button", { name: /macOS/ }).click();
  await screen.getByRole("button", { name: /Windows/ }).click();
  await screen.getByRole("button", { name: "Submit answers", exact: true }).click();
  await vi.waitFor(() =>
    expect(run).toHaveBeenCalledWith({
      environmentId: projection.environmentId,
      input: {
        ...address,
        deliveryId: projection.deliveryId,
        requestId: request.id,
        clientRequestId: expect.any(String),
        answers: { platforms: ["mac", "win"] },
      },
    }),
  );
});
