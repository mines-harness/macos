import type {
  EnvironmentId,
  GroupWorkflow,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

interface Target {
  readonly selection: ModelSelection;
  readonly interactionMode: ProviderInteractionMode;
  readonly text: string;
}

export const groupTargetKey = (target: Target) =>
  JSON.stringify({
    selection: {
      ...target.selection,
      options: target.selection.options?.toSorted((left, right) => left.id.localeCompare(right.id)),
    },
    interactionMode: target.interactionMode,
    text: target.text,
  });

/** A receipt is reusable only when every native launch and the shared prompt is identical. */
export const groupPreparationKey = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly branch: string;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly workflow: GroupWorkflow;
  readonly message: string;
  readonly targets: ReadonlyArray<Target>;
}) => JSON.stringify({ ...input, targets: input.targets.map(groupTargetKey) });
