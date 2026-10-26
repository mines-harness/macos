import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as WorkspaceRunLease from "./WorkspaceRunLease.ts";

const layerTest = WorkspaceRunLease.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Path.layer,
      FileSystem.layerNoop({
        exists: (path) =>
          Effect.succeed(
            path === "/checkout/.git" || (!path.endsWith("/missing") && !path.endsWith("/.git")),
          ),
        realPath: (path) =>
          path.endsWith("/missing")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: path,
                }),
              )
            : path === "/denied"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: path,
                  }),
                )
              : Effect.succeed(path.replace("/alias", "/checkout")),
      }),
    ),
  ),
);

it.effect("treats projects in nested folders of one checkout as the same writer resource", () =>
  Effect.gen(function* () {
    const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
    const first = yield* leases.acquire({ cwd: "/checkout", ownerId: "first", runId: "run:first" });
    const busy = yield* leases
      .acquire({ cwd: "/alias/packages/web", ownerId: "second", runId: "run:second" })
      .pipe(Effect.flip);
    assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
    yield* first.release;
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects a concurrent writer through a checkout alias without blocking independent worktrees",
  () =>
    Effect.gen(function* () {
      const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
      const first = yield* leases.acquire({
        cwd: "/checkout",
        ownerId: "first",
        runId: "run:first",
      });
      const busy = yield* leases
        .acquire({ cwd: "/alias/../alias", ownerId: "second", runId: "run:second" })
        .pipe(Effect.flip);
      assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
      const independent = yield* leases.acquire({
        cwd: "/worktrees/separate",
        ownerId: "third",
        runId: "run:third",
      });
      yield* independent.release;
      yield* first.release;
      const second = yield* leases.acquire({
        cwd: "/alias",
        ownerId: "second",
        runId: "run:second",
      });
      yield* second.release;
    }).pipe(Effect.provide(layerTest)),
);

it.effect("canonicalizes existing ancestors before a missing worktree is restored", () =>
  Effect.gen(function* () {
    const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
    const first = yield* leases.acquire({
      cwd: "/checkout/missing",
      ownerId: "first",
      runId: "run:first",
    });
    const busy = yield* leases
      .acquire({ cwd: "/alias/missing", ownerId: "second", runId: "run:second" })
      .pipe(Effect.flip);
    assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
    yield* first.release;
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "allows delegated work in the owning workflow without releasing other writers early",
  () =>
    Effect.gen(function* () {
      const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
      const parent = yield* leases.acquire({
        cwd: "/checkout",
        ownerId: "workflow",
        runId: "run:parent",
      });
      const child = yield* leases.acquire({
        cwd: "/alias",
        ownerId: "workflow",
        runId: "run:child",
      });
      yield* parent.release;
      const busy = yield* leases
        .acquire({ cwd: "/checkout", ownerId: "other-thread", runId: "run:other" })
        .pipe(Effect.flip);
      assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
      yield* child.release;
      const next = yield* leases.acquire({
        cwd: "/checkout",
        ownerId: "other-thread",
        runId: "run:other",
      });
      yield* next.release;
    }).pipe(Effect.provide(layerTest)),
);

it.effect("makes release idempotent across cancelled or failed startup cleanup", () =>
  Effect.gen(function* () {
    const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
    const first = yield* leases.acquire({ cwd: "/checkout", ownerId: "first", runId: "run:first" });
    yield* first.release;
    const next = yield* leases.acquire({ cwd: "/checkout", ownerId: "next", runId: "run:next" });
    yield* first.release;
    const busy = yield* leases
      .acquire({ cwd: "/checkout", ownerId: "last", runId: "run:last" })
      .pipe(Effect.flip);
    assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
    yield* next.release;
  }).pipe(Effect.provide(layerTest)),
);

it.effect("fails closed when the checkout cannot be canonicalized", () =>
  Effect.gen(function* () {
    const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
    const error = yield* leases
      .acquire({ cwd: "/denied", ownerId: "first", runId: "run:first" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceRunLeaseError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "holds the checkout until execution and checkpoint settle (checkpoint first: %s)",
  (checkpointFirst) =>
    Effect.gen(function* () {
      const leases = yield* WorkspaceRunLease.WorkspaceRunLease;
      const first = yield* leases.acquire({
        cwd: "/checkout",
        ownerId: "first",
        runId: "run:first",
      });
      yield* first.checkpointScheduled;
      yield* checkpointFirst ? leases.completeCheckpoint("run:first") : first.executionSettled;
      const busy = yield* leases
        .acquire({ cwd: "/checkout", ownerId: "next", runId: "run:next" })
        .pipe(Effect.flip);
      assert.equal(busy._tag, "WorkspaceRunLeaseBusy");
      yield* checkpointFirst ? first.executionSettled : leases.completeCheckpoint("run:first");
      const next = yield* leases.acquire({ cwd: "/checkout", ownerId: "next", runId: "run:next" });
      yield* next.executionSettled;
      yield* leases.completeCheckpoint("run:first");
      const last = yield* leases.acquire({ cwd: "/checkout", ownerId: "last", runId: "run:last" });
      yield* last.release;
    }).pipe(Effect.provide(layerTest)),
);
