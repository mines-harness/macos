import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  GroupWorkflow,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

export const WorkflowTarget = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
  selection: Schema.NullOr(ModelSelection),
  branch: Schema.String,
  startFromOrigin: Schema.Boolean,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  alias: Schema.String,
  role: Schema.String,
});
export type WorkflowTarget = typeof WorkflowTarget.Type;
export const WorkflowTargetDraft = Schema.Struct({
  workflow: GroupWorkflow,
  targets: Schema.Array(WorkflowTarget),
  leadId: Schema.String,
});
export const WorkflowLaunchReceipt = Schema.Struct({
  key: Schema.String,
  requestId: Schema.String,
  launches: Schema.Array(
    Schema.Struct({ targetId: Schema.String, threadId: ThreadId, commandId: CommandId }),
  ),
});
export type WorkflowLaunchReceipt = typeof WorkflowLaunchReceipt.Type;

export function workflowLaunchKey(input: {
  coordinator: EnvironmentId;
  message: string;
  draft: typeof WorkflowTargetDraft.Type;
  workspaceRoots: ReadonlyArray<string>;
}): string {
  return JSON.stringify({
    ...input,
    draft: {
      ...input.draft,
      targets: input.draft.targets.map((target) => ({
        ...target,
        selection: target.selection && {
          ...target.selection,
          options: target.selection.options?.toSorted((a, b) => a.id.localeCompare(b.id)),
        },
      })),
    },
  });
}

/** Switching one target never carries credentials or project ids onto another host. */
export function retargetWorkflowDevice(
  target: WorkflowTarget,
  environmentId: EnvironmentId,
): WorkflowTarget {
  return target.environmentId === environmentId
    ? target
    : {
        ...target,
        environmentId,
        projectId: null,
        selection: null,
        branch: "HEAD",
        startFromOrigin: false,
      };
}
