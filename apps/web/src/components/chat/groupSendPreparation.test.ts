import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { groupPreparationKey, groupTargetKey } from "./groupSendPreparation";

const target = {
  selection: {
    instanceId: ProviderInstanceId.make("codex-work"),
    model: "gpt-5",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  },
  interactionMode: "default" as const,
  text: "Build it",
};
const input = {
  environmentId: EnvironmentId.make("host-one"),
  projectId: ProjectId.make("project-one"),
  workspaceRoot: "/work/project",
  branch: "main",
  startFromOrigin: false,
  runtimeMode: "full-access" as const,
  workflow: "team" as const,
  message: "Build it",
  targets: [target],
};

describe("group preparation receipts", () => {
  it("reuses equivalent selected-model options regardless of property insertion order", () => {
    expect(groupTargetKey(target)).toBe(
      groupTargetKey({
        ...target,
        selection: { ...target.selection, options: target.selection.options.toReversed() },
      }),
    );
  });

  it("separates changed host, workspace, permission, context and target launch bindings", () => {
    const original = groupPreparationKey(input);
    const changed = [
      { ...input, environmentId: EnvironmentId.make("host-two") },
      { ...input, projectId: ProjectId.make("project-two") },
      { ...input, workspaceRoot: "/other/project" },
      { ...input, branch: "release" },
      { ...input, startFromOrigin: true },
      { ...input, runtimeMode: "approval-required" as const },
      { ...input, workflow: "council" as const },
      { ...input, message: "Build it\n<terminal_context>Changed output</terminal_context>" },
      { ...input, targets: [{ ...target, interactionMode: "plan" as const }] },
      { ...input, targets: [{ ...target, text: "ultrathink Build it" }] },
      {
        ...input,
        targets: [
          {
            ...target,
            selection: { ...target.selection, options: [{ id: "reasoningEffort", value: "low" }] },
          },
        ],
      },
      {
        ...input,
        targets: [
          {
            ...target,
            selection: {
              ...target.selection,
              instanceId: ProviderInstanceId.make("codex-personal"),
            },
          },
        ],
      },
    ];
    for (const next of changed) expect(groupPreparationKey(next)).not.toBe(original);
    expect(new Set(changed.map(groupPreparationKey)).size).toBe(changed.length);
  });
});
