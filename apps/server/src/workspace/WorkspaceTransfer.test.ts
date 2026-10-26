import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MINE_TRANSFER_MAX_BUNDLE_BYTES } from "@t3tools/contracts";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as WorkspaceTransfer from "./WorkspaceTransfer.ts";

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-transfer-config-" })),
);
const layerCheckpoint = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProjectConfig.layer),
);
const layerTest = WorkspaceTransfer.layer.pipe(
  Layer.provideMerge(layerCheckpoint),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(NodeServices.layer),
);

const makeFixture = Effect.fn("WorkspaceTransfer.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-" });
  const cwd = path.join(parent, "source");
  yield* fs.makeDirectory(cwd);
  const run = (args: readonly string[]) =>
    git.execute({ operation: "WorkspaceTransfer.test.git", cwd, args });
  yield* run(["init", "--initial-branch=main"]);
  yield* run(["config", "user.name", "Test"]);
  yield* run(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* fs.writeFileString(path.join(cwd, "deleted.txt"), "initial\n");
  yield* fs.writeFileString(path.join(cwd, ".gitignore"), ".env\nnode_modules/\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  return { fs, path, git, parent, cwd, run };
});

it.live("round-trips pending files without changing the source branch or index", () =>
  Effect.gen(function* () {
    const { fs, path, git, parent, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* fs.writeFileString(path.join(cwd, "file.txt"), "staged\n");
    yield* run(["add", "file.txt"]);
    yield* fs.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
    yield* fs.remove(path.join(cwd, "deleted.txt"));
    yield* fs.writeFile(path.join(cwd, "new é.bin"), new Uint8Array([0, 255, 10, 128]));
    yield* fs.writeFileString(path.join(cwd, ".env"), "SECRET=private\n");
    const index = yield* fs.readFile(path.join(cwd, ".git", "index"));
    const status = (yield* run(["status", "--porcelain=v1", "-z"])).stdout;
    const head = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-roundtrip-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);

    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), index);
    assert.equal((yield* run(["status", "--porcelain=v1", "-z"])).stdout, status);
    assert.equal((yield* run(["symbolic-ref", "HEAD"])).stdout.trim(), "refs/heads/main");
    assert.equal((yield* run(["rev-parse", "HEAD"])).stdout.trim(), head);

    const destinationPath = path.join(parent, "destination");
    const received = yield* service.importSnapshot({
      bundlePath: prepared.bundlePath,
      manifest: prepared.manifest,
      destinationPath,
    });
    assert.equal(received.cwd, destinationPath);
    assert.equal(received.head, head);
    assert.equal(yield* fs.readFileString(path.join(destinationPath, "file.txt")), "unstaged\n");
    assert.deepEqual(
      yield* fs.readFile(path.join(destinationPath, "new é.bin")),
      new Uint8Array([0, 255, 10, 128]),
    );
    assert.isFalse(yield* fs.exists(path.join(destinationPath, "deleted.txt")));
    assert.isFalse(yield* fs.exists(path.join(destinationPath, ".env")));
    const destination = (args: readonly string[]) =>
      git.execute({ operation: "WorkspaceTransfer.test.git", cwd: destinationPath, args });
    assert.equal((yield* destination(["rev-parse", "HEAD"])).stdout.trim(), head);
    assert.equal((yield* destination(["symbolic-ref", "HEAD"])).stdout.trim(), "refs/heads/main");
    assert.include((yield* destination(["status", "--porcelain=v1"])).stdout, '?? "new');
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live.each([
  "https://github.com/example/project.git",
  "ssh://git@forge.example:2222/team/project.git",
  "git@github.com:example/project.git",
])("preserves the source branch and credential-free origin %s", (originUrl) =>
  Effect.gen(function* () {
    const { fs, path, git, parent, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* run(["checkout", "-b", "feature/transfer"]);
    yield* run(["remote", "add", "origin", originUrl]);
    yield* fs.writeFileString(path.join(cwd, "file.txt"), "pending work\n");
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-origin-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    assert.equal(prepared.manifest.sourceBranch, "feature/transfer");
    assert.equal(prepared.manifest.originUrl, originUrl);
    const destinationPath = path.join(parent, "destination");
    yield* service.importSnapshot({ ...prepared, destinationPath });
    const destination = (args: readonly string[]) =>
      git.execute({ operation: "WorkspaceTransfer.test.git", cwd: destinationPath, args });
    assert.equal(
      (yield* destination(["symbolic-ref", "HEAD"])).stdout.trim(),
      "refs/heads/feature/transfer",
    );
    assert.equal(
      (yield* destination(["config", "--get", "remote.origin.url"])).stdout.trim(),
      originUrl,
    );
    assert.equal(
      yield* fs.readFileString(path.join(destinationPath, "file.txt")),
      "pending work\n",
    );
    assert.include((yield* destination(["status", "--porcelain=v1"])).stdout, " M file.txt");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live.each([
  "https://token@github.com/example/project.git",
  "https://user:secret@github.com/example/project.git",
  "https://github.com/example/project.git?token=secret",
  "https://github.com/example/project.git#secret",
  "https://github.com/example/project.git?",
  "https://github.com/example/project.git#",
  "ssh://git:secret@forge.example/team/project.git",
  "ssh://git@forge.example/team/project.git?token=secret",
  "file:///srv/private/project",
  "/srv/private/project",
  "../other-project",
  "ext::custom-transport",
])("omits credential-bearing or local origin %s", (originUrl) =>
  Effect.gen(function* () {
    const { path, git, parent, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* run(["remote", "add", "origin", originUrl]);
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-unsafe-origin-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    assert.isUndefined(prepared.manifest.originUrl);
    const destinationPath = path.join(parent, "destination");
    yield* service.importSnapshot({ ...prepared, destinationPath });
    const remote = yield* git.execute({
      operation: "WorkspaceTransfer.test.git",
      cwd: destinationPath,
      args: ["config", "--get", "remote.origin.url"],
      allowNonZeroExit: true,
    });
    assert.equal(remote.exitCode, 1);
    assert.equal(remote.stdout, "");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("preserves a detached source checkout", () =>
  Effect.gen(function* () {
    const { path, git, parent, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* run(["checkout", "--detach"]);
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-detached-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    assert.isUndefined(prepared.manifest.sourceBranch);
    const destinationPath = path.join(parent, "destination");
    yield* service.importSnapshot({ ...prepared, destinationPath });
    const branch = yield* git.execute({
      operation: "WorkspaceTransfer.test.git",
      cwd: destinationPath,
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
    });
    assert.equal(branch.exitCode, 1);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("rejects LFS pointer blobs when attributes are only local", () =>
  Effect.gen(function* () {
    const { fs, path, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* fs.writeFileString(
      path.join(cwd, ".git", "info", "attributes"),
      "asset.bin filter=local-lfs\n",
    );
    yield* fs.writeFileString(
      path.join(cwd, "asset.bin"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1048576\n`,
    );
    const error = yield* service
      .prepare({ cwd, transferId: "transfer-lfs-pointer-001" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected")
      assert.equal(error.reason, "unsupported-repository");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live.each(["branch", "origin"] as const)(
  "rejects unsafe imported %s metadata before creating a directory",
  (kind) =>
    Effect.gen(function* () {
      const { fs, path, parent, cwd } = yield* makeFixture();
      const service = yield* WorkspaceTransfer.WorkspaceTransfer;
      const prepared = yield* service.prepare({ cwd, transferId: "transfer-unsafe-import-001" });
      yield* Effect.addFinalizer(() => prepared.dispose);
      const destinationPath = path.join(parent, "destination");
      const manifest =
        kind === "branch"
          ? { ...prepared.manifest, sourceBranch: "invalid..branch" }
          : { ...prepared.manifest, originUrl: "https://token@github.com/example/repo.git" };
      const error = yield* service
        .importSnapshot({ ...prepared, manifest, destinationPath })
        .pipe(Effect.flip);
      assert.equal(error._tag, "WorkspaceTransferRejected");
      if (error._tag === "WorkspaceTransferRejected")
        assert.equal(error.reason, "invalid-manifest");
      assert.isFalse(yield* fs.exists(destinationPath));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("refuses an existing dirty destination without changing its files", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-existing-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    const destinationPath = path.join(parent, "destination");
    yield* fs.makeDirectory(destinationPath);
    yield* fs.writeFileString(path.join(destinationPath, "unsaved.txt"), "keep my work\n");
    const error = yield* service.importSnapshot({ ...prepared, destinationPath }).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected")
      assert.equal(error.reason, "destination-exists");
    assert.equal(
      yield* fs.readFileString(path.join(destinationPath, "unsaved.txt")),
      "keep my work\n",
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("refuses a dangling destination symlink", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-symlink-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    const destinationPath = path.join(parent, "destination");
    const target = path.join(parent, "missing");
    yield* fs.symlink(target, destinationPath);
    const error = yield* service.importSnapshot({ ...prepared, destinationPath }).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected")
      assert.equal(error.reason, "destination-exists");
    assert.equal(yield* fs.readLink(destinationPath), target);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("rejects tampering before creating the destination and retains its recovery snapshot", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-tampered-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    yield* fs.writeFileString(prepared.bundlePath, "invalid transfer\n");
    const destinationPath = path.join(parent, "destination");
    const error = yield* service.importSnapshot({ ...prepared, destinationPath }).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected") assert.equal(error.reason, "checksum-mismatch");
    assert.isFalse(yield* fs.exists(destinationPath));
    yield* prepared.dispose;
    assert.isFalse(yield* fs.exists(prepared.bundlePath));
    assert.equal(
      (yield* run(["rev-parse", prepared.manifest.snapshotRef])).stdout.trim(),
      prepared.manifest.snapshotCommit,
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("refuses an oversized incoming bundle before reading or importing it", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-oversized-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    yield* fs.truncate(prepared.bundlePath, MINE_TRANSFER_MAX_BUNDLE_BYTES + 1);
    const destinationPath = path.join(parent, "destination");
    const error = yield* service.importSnapshot({ ...prepared, destinationPath }).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected") assert.equal(error.reason, "bundle-too-large");
    assert.isFalse(yield* fs.exists(destinationPath));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("cleans its new destination when snapshot metadata disagrees with the bundle", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-metadata-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    const destinationPath = path.join(parent, "destination");
    const error = yield* service
      .importSnapshot({
        ...prepared,
        manifest: { ...prepared.manifest, snapshotTree: prepared.manifest.sourceHead },
        destinationPath,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected") assert.equal(error.reason, "snapshot-mismatch");
    assert.isFalse(yield* fs.exists(destinationPath));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("retries an unchanged completed import but preserves subsequent destination work", () =>
  Effect.gen(function* () {
    const { fs, path, parent, cwd } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* fs.writeFileString(path.join(cwd, "new.txt"), "pending\n");
    const prepared = yield* service.prepare({ cwd, transferId: "transfer-retry-001" });
    yield* Effect.addFinalizer(() => prepared.dispose);
    const destinationPath = path.join(parent, "destination");
    const input = { ...prepared, destinationPath };
    const original = yield* service.importSnapshot(input);
    assert.deepEqual(yield* service.importSnapshot(input), original);
    yield* fs.writeFileString(path.join(destinationPath, "new.txt"), "continued work\n");
    const error = yield* service.importSnapshot(input).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected")
      assert.equal(error.reason, "destination-exists");
    assert.equal(
      yield* fs.readFileString(path.join(destinationPath, "new.txt")),
      "continued work\n",
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live("rebuilds a source bundle from its recovery ref and rejects changed source work", () =>
  Effect.gen(function* () {
    const { fs, path, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    yield* fs.writeFileString(path.join(cwd, "new.txt"), "pending\n");
    const input = { cwd, transferId: "transfer-prepare-retry-001" };
    const original = yield* service.prepare(input);
    yield* original.dispose;
    const recovered = yield* service.prepare(input);
    yield* Effect.addFinalizer(() => recovered.dispose);
    assert.deepEqual(recovered.manifest, original.manifest);
    assert.isTrue(yield* fs.exists(recovered.bundlePath));
    yield* fs.writeFileString(path.join(cwd, "new.txt"), "continued work\n");
    const error = yield* service.prepare(input).pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected") assert.equal(error.reason, "transfer-exists");
    assert.equal(
      (yield* run(["rev-parse", original.manifest.snapshotRef])).stdout.trim(),
      original.manifest.snapshotCommit,
    );
    assert.equal(yield* fs.readFileString(path.join(cwd, "new.txt")), "continued work\n");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.live.each([
  "sparse",
  "shallow",
  "lfs",
  "gitlink",
  "embedded",
  "nested-workspace",
  "unborn",
] as const)("explicitly rejects unsupported %s workspaces", (kind) =>
  Effect.gen(function* () {
    const { fs, path, cwd, run } = yield* makeFixture();
    const service = yield* WorkspaceTransfer.WorkspaceTransfer;
    let requestedCwd = cwd;
    if (kind === "sparse") yield* run(["config", "core.sparseCheckout", "true"]);
    if (kind === "shallow") {
      const head = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(path.join(cwd, ".git", "shallow"), `${head}\n`);
    }
    if (kind === "lfs")
      yield* fs.writeFileString(
        path.join(cwd, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
    if (kind === "gitlink") {
      const head = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
      yield* run(["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
      yield* run(["commit", "-m", "submodule"]);
    }
    if (kind === "embedded") {
      yield* run(["init", "nested"]);
      yield* fs.writeFileString(path.join(cwd, "nested", "new.txt"), "nested work\n");
    }
    if (kind === "nested-workspace") {
      requestedCwd = path.join(cwd, "nested");
      yield* fs.makeDirectory(requestedCwd);
    }
    if (kind === "unborn") yield* run(["checkout", "--orphan", "unborn"]);
    const error = yield* service
      .prepare({ cwd: requestedCwd, transferId: "transfer-unsupported-001" })
      .pipe(Effect.flip);
    assert.equal(error._tag, "WorkspaceTransferRejected");
    if (error._tag === "WorkspaceTransferRejected") {
      assert.equal(
        error.reason,
        kind === "nested-workspace"
          ? "repository-root-required"
          : kind === "unborn"
            ? "head-required"
            : "unsupported-repository",
      );
    }
    const refs = yield* run(["for-each-ref", "--format=%(refname)", "refs/mines/handoffs/"]);
    assert.equal(refs.stdout, "");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
