import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  WorkflowLaunchReceipt,
  WorkflowTargetDraft,
  retargetWorkflowDevice,
  workflowLaunchKey,
  type WorkflowTarget,
} from "./workflowTargets";

const first: WorkflowTarget = {
  id: "target-one",
  environmentId: EnvironmentId.make("mac"),
  projectId: ProjectId.make("work"),
  selection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt",
    options: [
      { id: "effort", value: "high" },
      { id: "speed", value: "fast" },
    ],
  },
  branch: "main",
  startFromOrigin: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  alias: "builder",
  role: "Implementation",
};
const second: WorkflowTarget = {
  ...first,
  id: "target-two",
  environmentId: EnvironmentId.make("linux"),
  alias: "reviewer",
};
const input = {
  coordinator: first.environmentId,
  message: "Review this\n<context>source</context>",
  draft: { workflow: "build-review" as const, targets: [first, second], leadId: first.id },
  workspaceRoots: ["/Users/me/work", "/home/me/work"],
};

const decodeDraft = Schema.decodeSync(Schema.fromJsonString(WorkflowTargetDraft));
const encodeDraft = Schema.encodeSync(Schema.fromJsonString(WorkflowTargetDraft));
const decodeReceipt = Schema.decodeSync(Schema.fromJsonString(WorkflowLaunchReceipt));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(WorkflowLaunchReceipt));

describe("retained workflow targets", () => {
  it("retains same-named accounts on separate devices across persistence", () => {
    const restored = decodeDraft(encodeDraft(input.draft));
    expect(restored.targets).toEqual([first, second]);
    expect(restored.targets[0]?.selection?.instanceId).toBe(
      restored.targets[1]?.selection?.instanceId,
    );
    expect(restored.targets[0]?.environmentId).not.toBe(restored.targets[1]?.environmentId);
  });

  it("changing one device clears only that target's machine-bound project and credentials", () => {
    const changed = retargetWorkflowDevice(first, second.environmentId);
    expect(changed.environmentId).toBe(second.environmentId);
    expect(changed.projectId).toBeNull();
    expect(changed.selection).toBeNull();
    expect(changed.branch).toBe("HEAD");
    expect(changed.startFromOrigin).toBe(false);
    expect(second.selection).toEqual(first.selection);
    expect(retargetWorkflowDevice(first, first.environmentId)).toBe(first);
  });

  it("never reuses native launch receipts after a different device, account, permission, workspace, lead or prompt is chosen", () => {
    const original = workflowLaunchKey(input);
    const changes: Array<Partial<WorkflowTarget>> = [
      { environmentId: EnvironmentId.make("third-host") },
      { projectId: ProjectId.make("another") },
      { selection: { instanceId: ProviderInstanceId.make("personal"), model: "gpt" } },
      { selection: { ...first.selection!, options: [{ id: "effort", value: "low" }] } },
      { branch: "release" },
      { runtimeMode: "approval-required" },
      { interactionMode: "plan" },
    ];
    for (const change of changes)
      expect(
        workflowLaunchKey({
          ...input,
          draft: { ...input.draft, targets: [{ ...first, ...change }, second] },
        }),
      ).not.toBe(original);
    expect(workflowLaunchKey({ ...input, message: "different" })).not.toBe(original);
    expect(workflowLaunchKey({ ...input, workspaceRoots: ["/new", "/home/me/work"] })).not.toBe(
      original,
    );
    expect(workflowLaunchKey({ ...input, draft: { ...input.draft, leadId: second.id } })).not.toBe(
      original,
    );
    expect(
      workflowLaunchKey({
        ...input,
        draft: {
          ...input.draft,
          targets: [
            {
              ...first,
              selection: { ...first.selection!, options: first.selection!.options!.toReversed() },
            },
            second,
          ],
        },
      }),
    ).toBe(original);
  });

  it("restores exact command and thread IDs for retries after a lost response", () => {
    const receipt = {
      key: workflowLaunchKey(input),
      requestId: "stable-request",
      launches: [
        {
          targetId: first.id,
          threadId: ThreadId.make("original-thread"),
          commandId: CommandId.make("original-command"),
        },
      ],
    };
    expect(decodeReceipt(encodeReceipt(receipt))).toEqual(receipt);
  });
});
