import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceRunLease from "../workspace/WorkspaceRunLease.ts";
import * as CatalogRunContextService from "../catalog/CatalogRunContextService.ts";

export const layer = Layer.mergeAll(
  Layer.mock(CatalogRunContextService.CatalogRunContextService)({
    forRun: () => Effect.succeed(""),
  }),
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some({ workspaceRoot: "/tmp/provider-replay" } as never)),
  }),
  Layer.mock(WorkspaceRunLease.WorkspaceRunLease)({
    acquire: () =>
      Effect.succeed({
        release: Effect.void,
        executionSettled: Effect.void,
        checkpointScheduled: Effect.void,
      }),
    completeCheckpoint: () => Effect.void,
  }),
);
