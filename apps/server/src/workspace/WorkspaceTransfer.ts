// @effect-diagnostics-next-line nodeBuiltinImport:off -- Crypto.digest cannot hash bundles incrementally.
import * as NodeCrypto from "node:crypto";

import {
  CheckpointRef,
  MineTransferId,
  MINE_TRANSFER_MAX_BUNDLE_BYTES,
  WorkspaceTransferManifest,
  WorkspaceTransferOriginUrl,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const decodeTransferId = Schema.decodeEffect(MineTransferId);
const decodeManifest = Schema.decodeEffect(WorkspaceTransferManifest);
const manifestJson = Schema.fromJsonString(WorkspaceTransferManifest);
const decodeManifestJson = Schema.decodeEffect(manifestJson);
const encodeManifestJson = Schema.encodeEffect(manifestJson);
const manifestsEqual = Schema.toEquivalence(WorkspaceTransferManifest);
const isTransferableOrigin = Schema.is(WorkspaceTransferOriginUrl);

export class WorkspaceTransferError extends Schema.TaggedError<WorkspaceTransferError>()(
  "WorkspaceTransferError",
  { operation: Schema.Literals(["prepare", "import"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the workspace transfer.`;
  }
}

export class WorkspaceTransferRejected extends Schema.TaggedError<WorkspaceTransferRejected>()(
  "WorkspaceTransferRejected",
  {
    reason: Schema.Literals([
      "invalid-manifest",
      "repository-root-required",
      "head-required",
      "unsupported-repository",
      "bundle-too-large",
      "checksum-mismatch",
      "snapshot-mismatch",
      "destination-exists",
      "transfer-exists",
    ]),
  },
) {
  override get message(): string {
    return `Workspace transfer refused: ${this.reason}.`;
  }
}

export class WorkspaceTransfer extends Context.Service<
  WorkspaceTransfer,
  {
    readonly prepare: (input: {
      readonly cwd: string;
      readonly transferId: string;
    }) => Effect.Effect<
      {
        readonly manifest: WorkspaceTransferManifest;
        readonly bundlePath: string;
        readonly dispose: Effect.Effect<void>;
      },
      WorkspaceTransferError | WorkspaceTransferRejected
    >;
    readonly importSnapshot: (input: {
      readonly bundlePath: string;
      readonly manifest: WorkspaceTransferManifest;
      readonly destinationPath: string;
    }) => Effect.Effect<
      { readonly cwd: string; readonly head: string },
      WorkspaceTransferError | WorkspaceTransferRejected
    >;
  }
>()("mines/workspace/WorkspaceTransfer") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const checkpoints = yield* CheckpointStore.CheckpointStore;

  const execute = Effect.fn("WorkspaceTransfer.execute")(function* (
    operation: WorkspaceTransferError["operation"],
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ) {
    return yield* git
      .execute({
        operation: `WorkspaceTransfer.${operation}`,
        cwd,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        allowNonZeroExit,
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.mapError((cause) => new WorkspaceTransferError({ operation, cause })));
  });

  const digestBundle = Effect.fn("WorkspaceTransfer.digestBundle")(function* (
    bundlePath: string,
    operation: WorkspaceTransferError["operation"],
  ) {
    const info = yield* fs
      .stat(bundlePath)
      .pipe(Effect.mapError((cause) => new WorkspaceTransferError({ operation, cause })));
    if (info.type !== "File" || info.size > BigInt(MINE_TRANSFER_MAX_BUNDLE_BYTES)) {
      return yield* new WorkspaceTransferRejected({ reason: "bundle-too-large" });
    }
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    yield* fs.stream(bundlePath).pipe(
      Stream.mapError((cause) => new WorkspaceTransferError({ operation, cause })),
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength;
        if (bytes > MINE_TRANSFER_MAX_BUNDLE_BYTES) {
          return Effect.fail(new WorkspaceTransferRejected({ reason: "bundle-too-large" }));
        }
        hash.update(chunk);
        return Effect.void;
      }),
    );
    return { bytes, sha256: hash.digest("hex") };
  });

  const repositoryIdentity = Effect.fn("WorkspaceTransfer.repositoryIdentity")(function* (
    operation: WorkspaceTransferError["operation"],
    cwd: string,
    head: string,
  ) {
    const roots = (yield* execute(operation, cwd, ["rev-list", "--max-parents=0", head])).stdout
      .trim()
      .split("\n")
      .sort();
    return NodeCrypto.createHash("sha256").update(roots.join("\n")).digest("hex");
  });

  const assertSupported = Effect.fn("WorkspaceTransfer.assertSupported")(function* (
    operation: WorkspaceTransferError["operation"],
    cwd: string,
    tree: string,
  ) {
    const entries = yield* execute(operation, cwd, ["ls-tree", "-r", "-z", tree]);
    if (
      entries.stdoutTruncated ||
      entries.stdout.split("\0").some((entry) => entry.startsWith("160000 "))
    ) {
      return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
    }
    const attributes = yield* execute(
      operation,
      cwd,
      [
        "grep",
        "-I",
        "-l",
        "-e",
        "filter=lfs",
        tree,
        "--",
        ":(glob)**/.gitattributes",
        ".gitattributes",
      ],
      true,
    );
    if (attributes.exitCode === 0) {
      return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
    }
    const matches = yield* execute(
      operation,
      cwd,
      [
        "grep",
        "-I",
        "-l",
        "-z",
        "-E",
        "-e",
        "^version https://git-lfs[.]github[.]com/spec/v1\r?$",
        tree,
        "--",
      ],
      true,
    );
    const candidates = matches.stdout.split("\0").filter(Boolean);
    if (matches.stdoutTruncated || candidates.length > 128 || matches.exitCode > 1) {
      return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
    }
    for (const candidate of candidates) {
      const size = (yield* execute(operation, cwd, ["cat-file", "-s", candidate])).stdout.trim();
      if (Number(size) > 1024) continue;
      const contents = (yield* execute(operation, cwd, ["cat-file", "blob", candidate])).stdout;
      if (
        /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n(?:ext-[^\r\n]+\r?\n)*oid sha256:[a-f0-9]{64}\r?\nsize [0-9]+\r?\n?$/.test(
          contents,
        )
      ) {
        return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
      }
    }
  });

  const workingTreeMatches = Effect.fn("WorkspaceTransfer.workingTreeMatches")(function* (
    operation: WorkspaceTransferError["operation"],
    cwd: string,
    transferId: string,
    snapshotTree: string,
  ) {
    const verificationRef = `refs/mines/handoff-verifications/${transferId}`;
    return yield* Effect.gen(function* () {
      yield* checkpoints
        .captureCheckpoint({ cwd, checkpointRef: CheckpointRef.make(verificationRef) })
        .pipe(Effect.mapError((cause) => new WorkspaceTransferError({ operation, cause })));
      const tree = (yield* execute(operation, cwd, [
        "rev-parse",
        `${verificationRef}^{tree}`,
      ])).stdout.trim();
      return tree === snapshotTree;
    }).pipe(
      Effect.ensuring(
        execute(operation, cwd, ["update-ref", "-d", verificationRef]).pipe(Effect.ignore),
      ),
    );
  });

  const prepare: WorkspaceTransfer["Service"]["prepare"] = Effect.fn("WorkspaceTransfer.prepare")(
    function* ({ cwd, transferId }) {
      yield* decodeTransferId(transferId).pipe(
        Effect.mapError(() => new WorkspaceTransferRejected({ reason: "invalid-manifest" })),
      );
      const root = (yield* execute("prepare", cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
      const physicalCwd = yield* fs
        .realPath(cwd)
        .pipe(
          Effect.mapError((cause) => new WorkspaceTransferError({ operation: "prepare", cause })),
        );
      if (root !== physicalCwd) {
        return yield* new WorkspaceTransferRejected({ reason: "repository-root-required" });
      }
      const head = yield* execute("prepare", cwd, ["rev-parse", "--verify", "HEAD"], true);
      if (head.exitCode !== 0)
        return yield* new WorkspaceTransferRejected({ reason: "head-required" });
      const sourceHead = head.stdout.trim();
      const branch = yield* execute("prepare", cwd, ["symbolic-ref", "--quiet", "HEAD"], true);
      const sourceBranch =
        branch.exitCode === 0 && branch.stdout.startsWith("refs/heads/")
          ? branch.stdout.trim().slice("refs/heads/".length)
          : undefined;
      const origin = yield* execute("prepare", cwd, ["config", "--get", "remote.origin.url"], true);
      const originUrl = origin.stdout.replace(/\n$/, "");
      const sparse = yield* execute(
        "prepare",
        cwd,
        ["config", "--bool", "core.sparseCheckout"],
        true,
      );
      const shallow = yield* execute("prepare", cwd, ["rev-parse", "--is-shallow-repository"]);
      if (sparse.stdout.trim() === "true" || shallow.stdout.trim() === "true") {
        return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
      }
      yield* assertSupported("prepare", cwd, sourceHead);
      const untracked = yield* execute("prepare", cwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      if (untracked.stdoutTruncated) {
        return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
      }
      for (const entry of untracked.stdout.split("\0")) {
        if (
          entry.endsWith("/") &&
          (yield* fs
            .exists(path.join(cwd, entry, ".git"))
            .pipe(
              Effect.mapError(
                (cause) => new WorkspaceTransferError({ operation: "prepare", cause }),
              ),
            ))
        ) {
          return yield* new WorkspaceTransferRejected({ reason: "unsupported-repository" });
        }
      }
      const snapshotRef = `refs/mines/handoffs/${transferId}`;
      const existing = yield* execute(
        "prepare",
        cwd,
        ["show-ref", "--verify", "--quiet", snapshotRef],
        true,
      );
      const recovering = existing.exitCode === 0;
      if (recovering) {
        const commit = (yield* execute("prepare", cwd, [
          "rev-parse",
          `${snapshotRef}^{commit}`,
        ])).stdout.trim();
        const parents = (yield* execute("prepare", cwd, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          snapshotRef,
        ])).stdout.trim();
        const tree = (yield* execute("prepare", cwd, [
          "rev-parse",
          `${snapshotRef}^{tree}`,
        ])).stdout.trim();
        if (
          parents !== `${commit} ${sourceHead}` ||
          !(yield* workingTreeMatches("prepare", cwd, transferId, tree))
        ) {
          return yield* new WorkspaceTransferRejected({ reason: "transfer-exists" });
        }
      }
      return yield* Effect.acquireUseRelease(
        fs
          .makeTempDirectory({ prefix: "mines-workspace-transfer-" })
          .pipe(
            Effect.mapError((cause) => new WorkspaceTransferError({ operation: "prepare", cause })),
          ),
        (temporary) =>
          Effect.gen(function* () {
            const dispose = fs
              .remove(temporary, { recursive: true, force: true })
              .pipe(Effect.ignore);
            const bundlePath = path.join(temporary, "workspace.bundle");
            if (!recovering) {
              yield* checkpoints
                .captureCheckpoint({ cwd, checkpointRef: CheckpointRef.make(snapshotRef) })
                .pipe(
                  Effect.mapError(
                    (cause) => new WorkspaceTransferError({ operation: "prepare", cause }),
                  ),
                );
            }
            const snapshotCommit = (yield* execute("prepare", cwd, [
              "rev-parse",
              "--verify",
              snapshotRef,
            ])).stdout.trim();
            const snapshotTree = (yield* execute("prepare", cwd, [
              "rev-parse",
              "--verify",
              `${snapshotRef}^{tree}`,
            ])).stdout.trim();
            yield* assertSupported("prepare", cwd, snapshotCommit);
            const currentHead = (yield* execute("prepare", cwd, [
              "rev-parse",
              "HEAD",
            ])).stdout.trim();
            if (currentHead !== sourceHead)
              return yield* new WorkspaceTransferRejected({ reason: "snapshot-mismatch" });
            yield* execute("prepare", cwd, ["bundle", "create", bundlePath, snapshotRef]);
            const digest = yield* digestBundle(bundlePath, "prepare");
            return {
              manifest: {
                version: 1 as const,
                transferId,
                repositoryId: yield* repositoryIdentity("prepare", cwd, sourceHead),
                sourceHead,
                ...(sourceBranch !== undefined ? { sourceBranch } : {}),
                ...(origin.exitCode === 0 && isTransferableOrigin(originUrl) ? { originUrl } : {}),
                snapshotCommit,
                snapshotTree,
                snapshotRef,
                bundleSha256: digest.sha256,
                bundleBytes: digest.bytes,
              },
              bundlePath,
              dispose,
            };
          }),
        (temporary, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.all(
                [
                  fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
                  recovering
                    ? Effect.void
                    : execute("prepare", cwd, ["update-ref", "-d", snapshotRef]).pipe(
                        Effect.ignore,
                      ),
                ],
                { discard: true },
              ),
      );
    },
  );

  const verifyImported = Effect.fn("WorkspaceTransfer.verifyImported")(function* (
    cwd: string,
    manifest: WorkspaceTransferManifest,
  ) {
    const markerPath = path.join(cwd, ".git", "mines-transfer.json");
    const stored = yield* Effect.gen(function* () {
      const info = yield* fs.stat(markerPath);
      if (info.type !== "File" || info.size > 16_384n) return null;
      const contents = yield* fs.readFileString(markerPath);
      return yield* decodeManifestJson(contents);
    }).pipe(Effect.orElseSucceed(() => null));
    if (stored === null || !manifestsEqual(stored, manifest)) return false;
    const head = (yield* execute("import", cwd, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== manifest.sourceHead) return false;
    const branch = yield* execute("import", cwd, ["symbolic-ref", "--quiet", "HEAD"], true);
    if (
      manifest.sourceBranch !== undefined
        ? branch.stdout.trim() !== `refs/heads/${manifest.sourceBranch}`
        : branch.exitCode === 0
    )
      return false;
    const origin = yield* execute("import", cwd, ["config", "--get", "remote.origin.url"], true);
    if (
      manifest.originUrl !== undefined
        ? origin.stdout.replace(/\n$/, "") !== manifest.originUrl
        : origin.exitCode === 0
    )
      return false;
    return yield* workingTreeMatches("import", cwd, manifest.transferId, manifest.snapshotTree);
  });

  const importSnapshot: WorkspaceTransfer["Service"]["importSnapshot"] = Effect.fn(
    "WorkspaceTransfer.importSnapshot",
  )(function* (input) {
    const manifest = yield* decodeManifest(input.manifest).pipe(
      Effect.mapError(() => new WorkspaceTransferRejected({ reason: "invalid-manifest" })),
    );
    if (manifest.snapshotRef !== `refs/mines/handoffs/${manifest.transferId}`) {
      return yield* new WorkspaceTransferRejected({ reason: "invalid-manifest" });
    }
    const destinationPath = path.resolve(input.destinationPath);
    const parent = path.dirname(destinationPath);
    if (manifest.sourceBranch !== undefined) {
      const branch = yield* execute(
        "import",
        parent,
        ["check-ref-format", `refs/heads/${manifest.sourceBranch}`],
        true,
      );
      if (branch.exitCode !== 0)
        return yield* new WorkspaceTransferRejected({ reason: "invalid-manifest" });
    }
    const entries = yield* fs
      .readDirectory(parent)
      .pipe(Effect.mapError((cause) => new WorkspaceTransferError({ operation: "import", cause })));
    if (entries.includes(path.basename(destinationPath))) {
      if (yield* verifyImported(destinationPath, manifest))
        return { cwd: destinationPath, head: manifest.sourceHead };
      return yield* new WorkspaceTransferRejected({ reason: "destination-exists" });
    }
    const digest = yield* digestBundle(input.bundlePath, "import");
    if (digest.sha256 !== manifest.bundleSha256 || digest.bytes !== manifest.bundleBytes) {
      return yield* new WorkspaceTransferRejected({ reason: "checksum-mismatch" });
    }
    return yield* Effect.acquireUseRelease(
      fs
        .makeDirectory(destinationPath)
        .pipe(
          Effect.mapError((cause) =>
            cause.reason._tag === "AlreadyExists"
              ? new WorkspaceTransferRejected({ reason: "destination-exists" })
              : new WorkspaceTransferError({ operation: "import", cause }),
          ),
        ),
      () =>
        Effect.gen(function* () {
          yield* execute("import", parent, [
            "clone",
            "--no-checkout",
            "--template=",
            "--",
            path.resolve(input.bundlePath),
            destinationPath,
          ]);
          const heads = (yield* execute("import", destinationPath, [
            "bundle",
            "list-heads",
            path.resolve(input.bundlePath),
          ])).stdout
            .trim()
            .split("\n");
          if (
            heads.length !== 1 ||
            heads[0] !== `${manifest.snapshotCommit} ${manifest.snapshotRef}`
          ) {
            return yield* new WorkspaceTransferRejected({ reason: "snapshot-mismatch" });
          }
          yield* execute("import", destinationPath, [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            path.resolve(input.bundlePath),
            `${manifest.snapshotRef}:${manifest.snapshotRef}`,
          ]);
          const tree = (yield* execute("import", destinationPath, [
            "rev-parse",
            "--verify",
            `${manifest.snapshotCommit}^{tree}`,
          ])).stdout.trim();
          const parents = (yield* execute("import", destinationPath, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            manifest.snapshotCommit,
          ])).stdout.trim();
          const identity = yield* repositoryIdentity(
            "import",
            destinationPath,
            manifest.sourceHead,
          );
          if (
            tree !== manifest.snapshotTree ||
            parents !== `${manifest.snapshotCommit} ${manifest.sourceHead}` ||
            identity !== manifest.repositoryId
          ) {
            return yield* new WorkspaceTransferRejected({ reason: "snapshot-mismatch" });
          }
          yield* assertSupported("import", destinationPath, manifest.snapshotCommit);
          yield* execute("import", destinationPath, [
            "checkout",
            "--detach",
            manifest.snapshotCommit,
          ]);
          yield* execute("import", destinationPath, ["reset", "--mixed", manifest.sourceHead]);
          if (manifest.sourceBranch !== undefined) {
            const branchRef = `refs/heads/${manifest.sourceBranch}`;
            yield* execute("import", destinationPath, [
              "update-ref",
              branchRef,
              manifest.sourceHead,
            ]);
            yield* execute("import", destinationPath, ["symbolic-ref", "HEAD", branchRef]);
          }
          yield* execute("import", destinationPath, ["remote", "remove", "origin"]);
          if (manifest.originUrl !== undefined) {
            yield* execute("import", destinationPath, [
              "remote",
              "add",
              "origin",
              manifest.originUrl,
            ]);
          }
          yield* execute("import", destinationPath, [
            "update-ref",
            manifest.snapshotRef,
            manifest.snapshotCommit,
          ]);
          const marker = yield* encodeManifestJson(manifest).pipe(
            Effect.mapError((cause) => new WorkspaceTransferError({ operation: "import", cause })),
          );
          yield* fs
            .writeFileString(path.join(destinationPath, ".git", "mines-transfer.json"), marker)
            .pipe(
              Effect.mapError(
                (cause) => new WorkspaceTransferError({ operation: "import", cause }),
              ),
            );
          return { cwd: destinationPath, head: manifest.sourceHead };
        }),
      (_, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(destinationPath, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  });

  return WorkspaceTransfer.of({ prepare, importSnapshot });
});

export const layer = Layer.effect(WorkspaceTransfer, make);
