import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WorkspaceRunLeaseError extends Schema.TaggedError<WorkspaceRunLeaseError>()(
  "WorkspaceRunLeaseError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not identify the checkout before starting a provider run.";
  }
}

export class WorkspaceRunLeaseBusy extends Schema.TaggedError<WorkspaceRunLeaseBusy>()(
  "WorkspaceRunLeaseBusy",
  { cwd: Schema.String },
) {
  override get message(): string {
    return "Another workflow is using this checkout.";
  }
}

export const isWorkspaceRunLeaseBusy = Schema.is(WorkspaceRunLeaseBusy);

export class WorkspaceRunLease extends Context.Service<
  WorkspaceRunLease,
  {
    readonly acquire: (input: {
      readonly cwd: string;
      readonly ownerId: string;
      readonly runId: string;
    }) => Effect.Effect<
      {
        readonly release: Effect.Effect<void>;
        readonly executionSettled: Effect.Effect<void>;
        readonly checkpointScheduled: Effect.Effect<void>;
      },
      WorkspaceRunLeaseError | WorkspaceRunLeaseBusy
    >;
    readonly completeCheckpoint: (runId: string) => Effect.Effect<void>;
  }
>()("mines/workspace/WorkspaceRunLease") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const leases = new Map<string, { ownerId: string; holders: number }>();
  const checkpoints = new Map<string, Effect.Effect<void>>();

  const canonicalPath = Effect.fn("WorkspaceRunLease.canonicalPath")(function* (cwd: string) {
    let candidate = path.resolve(cwd);
    const missing: Array<string> = [];
    while (true) {
      const resolved = yield* fileSystem.realPath(candidate).pipe(
        Effect.matchEffect({
          onSuccess: (value) => Effect.succeed(value),
          onFailure: (cause) =>
            cause.reason._tag === "NotFound" && path.dirname(candidate) !== candidate
              ? Effect.void
              : Effect.fail(new WorkspaceRunLeaseError({ cwd, cause })),
        }),
      );
      if (resolved !== undefined) return path.join(resolved, ...missing);
      // A pruned managed worktree is recreated during startup; canonicalize its existing parent.
      missing.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  });

  const acquire: WorkspaceRunLease["Service"]["acquire"] = Effect.fn("WorkspaceRunLease.acquire")(
    function* ({ cwd, ownerId, runId }) {
      let key = yield* canonicalPath(cwd);
      if (
        yield* fileSystem
          .exists(key)
          .pipe(Effect.mapError((cause) => new WorkspaceRunLeaseError({ cwd, cause })))
      ) {
        let candidate = key;
        while (true) {
          const checkout = yield* fileSystem
            .exists(path.join(candidate, ".git"))
            .pipe(Effect.mapError((cause) => new WorkspaceRunLeaseError({ cwd, cause })));
          if (checkout) {
            key = candidate;
            break;
          }
          const parent = path.dirname(candidate);
          if (parent === candidate) break;
          candidate = parent;
        }
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const lease = leases.get(key) ?? { ownerId, holders: 0 };
          if (lease.ownerId !== ownerId) return yield* new WorkspaceRunLeaseBusy({ cwd: key });
          leases.set(key, lease);
          lease.holders++;
          let executionDone = false;
          let checkpointExpected = false;
          let checkpointDone = false;
          const settleIfComplete: Effect.Effect<void> = Effect.suspend(() =>
            executionDone && (!checkpointExpected || checkpointDone) ? release : Effect.void,
          );
          const completeCheckpoint = Effect.sync(() => {
            checkpointDone = true;
          }).pipe(Effect.andThen(settleIfComplete));
          const release = yield* Effect.cached(
            Effect.sync(() => {
              if (checkpoints.get(runId) === completeCheckpoint) checkpoints.delete(runId);
              lease.holders--;
              if (lease.holders === 0) leases.delete(key);
            }).pipe(Effect.uninterruptible),
          );
          checkpoints.set(runId, completeCheckpoint);
          return {
            release,
            executionSettled: Effect.sync(() => {
              executionDone = true;
            }).pipe(Effect.andThen(settleIfComplete)),
            checkpointScheduled: Effect.sync(() => {
              checkpointExpected = true;
            }),
          };
        }),
      );
    },
  );

  const completeCheckpoint = Effect.fn("WorkspaceRunLease.completeCheckpoint")((runId: string) =>
    Effect.suspend(() => checkpoints.get(runId) ?? Effect.void),
  );

  return WorkspaceRunLease.of({ acquire, completeCheckpoint });
});

export const layer = Layer.effect(WorkspaceRunLease, make);
