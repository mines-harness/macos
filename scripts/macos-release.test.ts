// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

async function readDesktopReleaseSteps(file = "release-desktop.yml") {
  const workflow = Schema.decodeSync(
    fromYaml(
      Schema.Struct({
        jobs: Schema.Record(
          Schema.String,
          Schema.Struct({
            steps: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  name: Schema.optional(Schema.String),
                  run: Schema.optional(Schema.String),
                  uses: Schema.optional(Schema.String),
                  id: Schema.optional(Schema.String),
                  with: Schema.optional(
                    Schema.Struct({
                      script: Schema.optional(Schema.String),
                      name: Schema.optional(Schema.String),
                      "run-id": Schema.optional(Schema.String),
                      "github-token": Schema.optional(Schema.String),
                    }),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  )(await NodeFSP.readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

async function runPersonalReleaseMetadata(input: {
  checks: ReadonlyArray<{ id: number; name: string; app: { slug: string }; conclusion: string }>;
  tags?: readonly string[];
  requestedVersion?: string;
  dispatchRef?: string;
}) {
  const script = (await readDesktopReleaseSteps("mines-personal-release.yml")).find(
    (step) => step.id === "meta",
  )?.with?.script;
  assert.isString(script);
  const checkedRefs: string[] = [];
  const outputs = new Map<string, string>();
  const listChecks = Symbol("checks");
  const listReleases = Symbol("releases");
  await (NodeVM.runInNewContext(`(async () => {\n${script!}\n})()`, {
    github: {
      rest: {
        checks: { listForRef: listChecks },
        repos: { listReleases },
      },
      paginate: async (method: unknown, options: { ref: string }) => {
        if (method === listChecks) {
          checkedRefs.push(options.ref);
          return input.checks;
        }
        if (method === listReleases) return (input.tags ?? []).map((tag_name) => ({ tag_name }));
        throw new Error("Unexpected GitHub method");
      },
    },
    context: {
      repo: { owner: "mines-harness", repo: "macos" },
      payload: input.dispatchRef ? {} : { workflow_run: { head_sha: "1".repeat(40) } },
      sha: "2".repeat(40),
      eventName: input.dispatchRef ? "workflow_dispatch" : "workflow_run",
      ref: input.dispatchRef ?? "refs/heads/main",
    },
    core: { setOutput: (name: string, value: string) => outputs.set(name, value) },
    require: (file: string) => {
      assert.equal(file, "./.github/mines-release.json");
      return {
        version: "1.2.3",
        sourceRepository: "mines-harness/macos",
        distributionRepository: "mines-harness/macos",
      };
    },
    process: { env: { VERSION: input.requestedVersion ?? "" } },
  }) as Promise<void>);
  return { checkedRefs, outputs };
}

it("allocates the next personal patch from the exact CI-tested source", async () => {
  const result = await runPersonalReleaseMetadata({
    checks: [{ id: 1, name: "Check", app: { slug: "github-actions" }, conclusion: "success" }],
    tags: ["v1.2.3", "v1.2.4", "v1.2.5-preview.20261029.1"],
  });
  assert.deepEqual(result.checkedRefs, ["1".repeat(40)]);
  assert.equal(result.outputs.get("commit"), "1".repeat(40));
  assert.equal(result.outputs.get("version"), "1.2.5");
});

async function runPersonalPublication(
  step: "resolve" | "source" | "publish",
  input: {
    repository?: string;
    ref?: string;
    runId?: string;
    run?: Record<string, unknown>;
    failedJob?: string;
    reuseNonmac?: boolean;
    checks?: ReadonlyArray<{ id: number; name: string; app: { slug: string }; conclusion: string }>;
    comparison?: {
      status: string;
      files?: ReadonlyArray<{ filename: string; previous_filename?: string }>;
    };
    source?: Record<string, unknown>;
    release?: Record<string, unknown>;
    missingMac?: string;
    signing?: Record<string, unknown>;
    mainMoved?: boolean;
    badDigest?: boolean;
    missingDraft?: boolean;
    duplicateDraft?: boolean;
  } = {},
) {
  const script = (await readDesktopReleaseSteps("mines-personal-publish.yml")).find(
    (candidate) => candidate.id === step,
  )?.with?.script;
  assert.isString(script);
  const commit = "1".repeat(40);
  const tree = "2".repeat(40);
  const main = "3".repeat(40);
  const repository = "mines-harness/macos";
  const runUrl = `https://github.com/${repository}/actions/runs/123`;
  const files = new Map<string, string>([
    ["pnpm-lock.yaml", "lockfile fixture"],
    [
      ".github/mines-release.json",
      JSON.stringify({ sourceRepository: repository, distributionRepository: repository }),
    ],
    [
      "release-assets/release-source.json",
      JSON.stringify({
        schemaVersion: 1,
        repository,
        commit,
        tree,
        lockfileSha256: NodeCrypto.createHash("sha256").update("lockfile fixture").digest("hex"),
        version: "0.1.19",
        channel: "stable",
        runUrl,
        ...input.source,
      }),
    ],
    [
      "release-assets/SIGNING.json",
      JSON.stringify({
        schemaVersion: 1,
        profile: "personal",
        version: "0.1.19",
        sourceCommit: commit,
        macos: {
          identityKind: "Apple Development",
          certificateSha1: "52879C68B5791127EB3A4BA446BBCD10A272DAE8",
          teamIdentifier: "89MW3QT5N2",
          notarized: false,
          strictSignatureVerified: true,
        },
        windows: { signed: false },
        linux: { signed: false },
        ...input.signing,
      }),
    ],
  ]);
  const macNames = ["arm64", "x64"].flatMap((arch) => [
    `mines-0.1.19-${arch}.dmg`,
    `mines-0.1.19-${arch}.zip`,
    `mines-0.1.19-${arch}.dmg.blockmap`,
    `mines-0.1.19-${arch}.zip.blockmap`,
    `latest-mac-${arch}.yml`,
    `provenance-mac-${arch}.json`,
  ]);
  macNames.push("mines-0.1.19-darwin-arm64.tar.gz", "SIGNING.json");
  const draft = {
    id: 789,
    draft: true,
    prerelease: false,
    tag_name: "v0.1.19",
    target_commitish: commit,
    ...input.release,
  };
  const methods = {
    jobs: Symbol("jobs"),
    checks: Symbol("checks"),
    assets: Symbol("assets"),
    releases: Symbol("releases"),
  };
  const outputs = new Map<string, string>();
  const checkedRefs: string[] = [];
  const uploads: ReadonlyArray<string>[] = [];
  const publications: Record<string, unknown>[] = [];
  const compareRefs: { base: string; head: string }[] = [];
  await (NodeVM.runInNewContext(`(async () => {\n${script!}\n})()`, {
    context: {
      repo: input.repository
        ? { owner: input.repository.split("/")[0], repo: input.repository.split("/")[1] }
        : { owner: "mines-harness", repo: "macos" },
      ref: input.ref ?? "refs/heads/main",
      runId: 456,
    },
    process: {
      env: {
        BUILD_RUN_ID: input.runId ?? "123",
        BUILD_RUN_URL: runUrl,
        BUILD_CONCLUSION: "failure",
        NONMAC_RUN_ID: input.reuseNonmac ? "123" : "456",
        SOURCE_COMMIT: commit,
        MAIN_COMMIT: main,
        VERSION: "0.1.19",
        TAG: "v0.1.19",
        RELEASE_ID: "789",
      },
    },
    core: {
      setOutput: (name: string, value: string) => outputs.set(name, value),
      summary: {
        addHeading() {
          return this;
        },
        addRaw() {
          return this;
        },
        write: async () => {},
      },
    },
    github: {
      rest: {
        actions: {
          getWorkflowRun: async () => ({
            data: {
              status: "completed",
              conclusion: "failure",
              path: ".github/workflows/mines-personal-release.yml",
              head_branch: "main",
              repository: { full_name: repository },
              head_repository: { full_name: repository },
              head_sha: commit,
              html_url: runUrl,
              ...input.run,
            },
          }),
          listJobsForWorkflowRun: methods.jobs,
        },
        checks: { listForRef: methods.checks },
        repos: {
          getBranch: async () => ({
            data: { commit: { sha: input.mainMoved ? "4".repeat(40) : main } },
          }),
          compareCommits: async (options: { base: string; head: string }) => {
            compareRefs.push({ base: options.base, head: options.head });
            return {
              data: input.comparison ?? {
                status: "ahead",
                files: [{ filename: ".github/workflows/mines-personal-publish.yml" }],
              },
            };
          },
          getReleaseByTag: async () => {
            throw new Error("GitHub returns 404 for unpublished draft tags");
          },
          listReleases: methods.releases,
          getRelease: async () => ({ data: draft }),
          listReleaseAssets: methods.assets,
          updateRelease: async (options: Record<string, unknown>) => {
            publications.push(options);
            return { data: { html_url: `https://github.com/${repository}/releases/tag/v0.1.19` } };
          },
        },
      },
      paginate: async (method: unknown, options: { ref: string; run_id: number }) => {
        if (method === methods.releases) {
          return input.missingDraft
            ? []
            : input.duplicateDraft
              ? [draft, { ...draft, id: 790 }]
              : [draft];
        }
        if (method === methods.jobs) {
          assert.equal(options.run_id, 123);
          return [
            "Resolve one tested personal release source",
            "Build shared server, composer, and desktop shell once",
            "Desktop Linux x64 / Build Linux x64",
            "Desktop Linux arm64 / Build Linux arm64",
            ...(input.reuseNonmac
              ? [
                  "Desktop Windows x64 / Build Windows x64",
                  "Desktop Windows arm64 / Build Windows arm64",
                ]
              : []),
          ].map((name) => ({
            name,
            status: "completed",
            conclusion: name === input.failedJob ? "failure" : "success",
          }));
        }
        if (method === methods.checks) {
          checkedRefs.push(options.ref);
          return (
            input.checks ?? [
              { id: 1, name: "Check", app: { slug: "github-actions" }, conclusion: "success" },
            ]
          );
        }
        if (method === methods.assets) {
          if (step === "source")
            return macNames
              .filter((name) => name !== input.missingMac)
              .map((name) => ({ name, state: "uploaded", size: 1 }));
          return [...files]
            .filter(([name]) => name.startsWith("release-assets/"))
            .map(([path, value]) => ({
              name: path.slice("release-assets/".length),
              state: "uploaded",
              size: Buffer.byteLength(value),
              digest: input.badDigest
                ? "sha256:wrong"
                : `sha256:${NodeCrypto.createHash("sha256").update(value).digest("hex")}`,
            }));
        }
        throw new Error("Unexpected publication GitHub request");
      },
    },
    require: (name: string) => {
      if (name === "node:crypto") return NodeCrypto;
      if (name === "node:fs")
        return {
          readFileSync: (path: string) => {
            const file = files.get(path);
            if (file === undefined) throw new Error(`Unexpected publication file: ${path}`);
            return file;
          },
          writeFileSync: (path: string, value: string) => files.set(path, value),
          readdirSync: () =>
            [...files.keys()]
              .filter((name) => name.startsWith("release-assets/"))
              .map((name) => name.slice("release-assets/".length)),
          statSync: (path: string) => ({ size: Buffer.byteLength(files.get(path)!) }),
        };
      if (name === "node:child_process")
        return {
          execFileSync: (command: string, args: string[]) => {
            if (command === "git") return args[1] === "HEAD" ? commit : tree;
            assert.equal(command, "gh");
            uploads.push(args);
            return "";
          },
        };
      throw new Error(`Unexpected publication require: ${name}`);
    },
  }) as Promise<void>);
  return { outputs, checkedRefs, compareRefs, uploads, publications, files };
}

it("rebuilds failed nonMac packaging from the original tested bundle and reuses complete successful builds", async () => {
  const result = await runPersonalPublication("resolve");
  assert.deepEqual(result.checkedRefs, ["1".repeat(40)]);
  assert.deepEqual(result.compareRefs, [{ base: "1".repeat(40), head: "3".repeat(40) }]);
  assert.equal(result.outputs.get("build-run-id"), "123");
  assert.equal(result.outputs.get("build-conclusion"), "failure");
  assert.equal(result.outputs.get("commit"), "1".repeat(40));
  assert.equal(result.outputs.get("nonmac-run-id"), "456");
  assert.equal(result.outputs.get("rebuild-nonmac"), "true");
  const reused = await runPersonalPublication("resolve", {
    reuseNonmac: true,
    run: { conclusion: "success" },
  });
  assert.equal(reused.outputs.get("nonmac-run-id"), "123");
  assert.equal(reused.outputs.get("rebuild-nonmac"), "false");
  await runPersonalPublication("resolve", {
    reuseNonmac: true,
    run: { conclusion: "success" },
    comparison: { status: "identical", files: [] },
  });
  await runPersonalPublication("resolve", { failedJob: "Desktop Linux x64 / Build Linux x64" });
  await expect(
    runPersonalPublication("resolve", {
      reuseNonmac: true,
      run: { conclusion: "success" },
      failedJob: "Desktop Linux x64 / Build Linux x64",
    }),
  ).rejects.toThrow("Required original build job");
});

it("rejects untrusted, unfinished, untested, or failed shared release inputs", async () => {
  for (const input of [
    { repository: "someone/fork" },
    { ref: "refs/heads/feature" },
    { runId: "123-not-a-run" },
    { run: { status: "in_progress" } },
    { run: { conclusion: "cancelled" } },
    { run: { head_branch: "feature" } },
    { run: { head_repository: { full_name: "someone/fork" } } },
    { run: { path: ".github/workflows/another-release.yml" } },
    { failedJob: "Resolve one tested personal release source" },
    { failedJob: "Build shared server, composer, and desktop shell once" },
    { checks: [{ id: 2, name: "Check", app: { slug: "github-actions" }, conclusion: "failure" }] },
  ]) {
    await expect(runPersonalPublication("resolve", input)).rejects.toThrow();
  }
});

it("allows only complete publication infrastructure changes ahead of the original source", async () => {
  await runPersonalPublication("resolve", {
    comparison: {
      status: "ahead",
      files: [
        { filename: ".github/workflows/mines-personal-publish.yml" },
        { filename: ".github/workflows/release-desktop.yml" },
        { filename: "scripts/macos-release.test.ts" },
        { filename: "docs/operations/mines-release.md" },
      ],
    },
  });
  for (const comparison of [
    { status: "behind", files: [] },
    { status: "diverged", files: [] },
    { status: "ahead" },
    { status: "ahead", files: [{ filename: "apps/web/src/composer.tsx" }] },
    {
      status: "ahead",
      files: [
        {
          filename: "scripts/macos-release.test.ts",
          previous_filename: "apps/server/src/runtime.ts",
        },
      ],
    },
    {
      status: "ahead",
      files: Array.from({ length: 300 }, () => ({ filename: "scripts/macos-release.test.ts" })),
    },
  ]) {
    await expect(runPersonalPublication("resolve", { comparison })).rejects.toThrow(
      "application drift",
    );
  }
});

it("finds unpublished drafts without relying on GitHub's published-tag lookup", async () => {
  const result = await runPersonalPublication("source");
  assert.equal(result.outputs.get("release-id"), "789");
  await expect(runPersonalPublication("source", { missingDraft: true })).rejects.toThrow(
    "exactly one",
  );
  await expect(runPersonalPublication("source", { duplicateDraft: true })).rejects.toThrow(
    "exactly one",
  );
});

it("requires exact stable source provenance and all fourteen Mac assets on the same exact draft", async () => {
  const result = await runPersonalPublication("source");
  assert.equal(result.outputs.get("tag"), "v0.1.19");
  assert.equal(result.outputs.get("mac-assets")?.split("\n").length, 14);
  for (const input of [
    { source: { schemaVersion: 2 } },
    { source: { repository: "someone/fork" } },
    { source: { commit: "9".repeat(40) } },
    { source: { tree: "9".repeat(40) } },
    { source: { lockfileSha256: "9".repeat(64) } },
    { source: { version: "0.1.19-preview.1" } },
    { source: { channel: "preview" } },
    { source: { runUrl: "https://github.com/mines-harness/macos/actions/runs/999" } },
    { release: { draft: false } },
    { release: { prerelease: true } },
    { release: { target_commitish: "main" } },
    { release: { tag_name: "v0.1.20" } },
    { missingMac: "latest-mac-x64.yml" },
  ]) {
    await expect(runPersonalPublication("source", input)).rejects.toThrow();
  }
});

it("publishes only after uploaded digest verification and preserves maintainer release notes", async () => {
  const result = await runPersonalPublication("publish");
  assert.equal(result.uploads.length, 1);
  assert.deepEqual(result.uploads[0]?.slice(0, 6), [
    "release",
    "upload",
    "v0.1.19",
    "--repo",
    "mines-harness/macos",
    "--clobber",
  ]);
  assert.deepEqual(result.publications, [
    {
      owner: "mines-harness",
      repo: "macos",
      release_id: 789,
      draft: false,
      prerelease: false,
      make_latest: "true",
    },
  ]);
  const runs = JSON.parse(result.files.get("release-assets/build-runs.json")!);
  assert.equal(runs.sharedBundle.runId, 123);
  assert.equal(runs.sharedBundle.conclusion, "failure");
  assert.equal(runs.nonMac.runId, 456);
  assert.equal(runs.publication.runId, 456);
  assert.include(result.files.get("release-assets/SHA256SUMS")!, "  build-runs.json\n");
  for (const input of [
    { signing: { sourceCommit: "9".repeat(40) } },
    { signing: { macos: { notarized: true } } },
    { signing: { windows: { signed: true } } },
    { mainMoved: true },
    { release: { draft: false } },
    { release: { target_commitish: "main" } },
    { badDigest: true },
  ]) {
    await expect(runPersonalPublication("publish", input)).rejects.toThrow();
  }
});

it("rejects a personal release when the latest CI check failed", async () => {
  await expect(
    runPersonalReleaseMetadata({
      checks: [
        { id: 1, name: "Check", app: { slug: "github-actions" }, conclusion: "success" },
        { id: 2, name: "Check", app: { slug: "github-actions" }, conclusion: "failure" },
      ],
    }),
  ).rejects.toThrow("CI Check has not passed");
});

it("requires CI on the dispatched commit and preserves an unused explicit version", async () => {
  const result = await runPersonalReleaseMetadata({
    checks: [{ id: 1, name: "Check", app: { slug: "github-actions" }, conclusion: "success" }],
    dispatchRef: "refs/heads/main",
    requestedVersion: "1.2.8",
  });
  assert.deepEqual(result.checkedRefs, ["2".repeat(40)]);
  assert.equal(result.outputs.get("commit"), "2".repeat(40));
  assert.equal(result.outputs.get("version"), "1.2.8");
});

it("rejects an occupied personal release version and dispatches outside main", async () => {
  const checks = [{ id: 1, name: "Check", app: { slug: "github-actions" }, conclusion: "success" }];
  await expect(
    runPersonalReleaseMetadata({ checks, tags: ["v1.2.3"], requestedVersion: "1.2.3" }),
  ).rejects.toThrow("already published release version");
  await expect(
    runPersonalReleaseMetadata({ checks, dispatchRef: "refs/heads/feature" }),
  ).rejects.toThrow("Personal releases must be dispatched from main");
});

it("waits for Linux CLI artifacts across transient failures and stops for missing or finished producers", async () => {
  const run = (await readDesktopReleaseSteps()).find(
    (step) => step.name === "Wait for Linux CLI archive",
  )?.run;
  const script = run?.match(/node --input-type=module <<'EOF'\n([\s\S]+)\nEOF/u)?.[1];
  assert.isString(script);
  const empty = { total_count: 0 };
  const ready = { total_count: 1 };
  const failed = { jobs: [{ name: "Desktop Linux x64 / Build Linux x64", conclusion: "failure" }] };
  for (const scenario of [
    { replies: [ready], failure: undefined },
    { replies: [{ status: 503 }, ready], failure: undefined },
    { replies: [empty, failed, ready], failure: undefined },
    { replies: [empty, failed, empty], failure: "ended (failure)" },
    { replies: [empty, { jobs: [] }, empty, { jobs: [] }], failure: "No job named" },
  ]) {
    const replies = [...scenario.replies];
    const messages: string[] = [];
    const requests: string[] = [];
    const process = {
      env: {
        GITHUB_API_URL: "https://api.example.test",
        GITHUB_REPOSITORY: "mines-harness/macos",
        GITHUB_RUN_ID: "123",
        ARTIFACT_RUN_ID: "789",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_TOKEN: "fixture-token",
        ARTIFACT: "cli-linux-x64",
        LINUX_JOB: "Build Linux x64",
      },
      exitCode: undefined as number | undefined,
    };
    let clock = 0;
    let scheduled = 0;
    await (NodeVM.runInNewContext(`(async () => {\n${script!}\n})()`, {
      process,
      console: Object.fromEntries(
        ["log", "warn", "error"].map((name) => [name, (message: string) => messages.push(message)]),
      ),
      fetch: async (url: string) => {
        requests.push(url);
        const response = replies.shift();
        if (!response) throw new Error("Unexpected GitHub request");
        const status = "status" in response ? response.status : 200;
        return { ok: status === 200, status, json: async () => response };
      },
      Date: { now: () => (clock += 300_000) },
      setTimeout: (callback: () => void) => {
        if (++scheduled > 2) throw new Error("Unexpected artifact wait");
        callback();
      },
    }) as Promise<void>);
    assert.equal(process.exitCode, scenario.failure ? 1 : undefined);
    assert.isEmpty(replies);
    assert.include(messages.join("\n"), scenario.failure ?? "cli-linux-x64 is ready");
    assert.isTrue(requests.every((url) => url.includes("/actions/runs/789/")));
    assert.isTrue(
      requests
        .filter((url) => url.includes("/jobs?"))
        .every((url) => url.endsWith("/jobs?filter=latest&per_page=100")),
    );
  }
});

it("downloads only shared build inputs from the selected source run and keeps target outputs in the current run", async () => {
  const steps = await readDesktopReleaseSteps();
  for (const name of [
    "Download dependency verification",
    "Download relay client tracing config",
    "Download canonical source provenance",
    "Download JS bundle",
  ]) {
    const step = steps.find((candidate) => candidate.name === name);
    assert.equal(step?.with?.["run-id"], "${{ inputs.artifact_run_id || github.run_id }}");
    assert.equal(step?.with?.["github-token"], "${{ github.token }}");
  }
  const linuxCli = steps.find((step) => step.name === "Download Linux CLI archive for WSL");
  assert.equal(
    linuxCli?.with?.["run-id"],
    "${{ inputs.linux_cli_run_id || inputs.artifact_run_id || github.run_id }}",
  );
  assert.equal(linuxCli?.with?.["github-token"], "${{ github.token }}");
  for (const name of ["Download verification inputs", "Download CLI archive"]) {
    assert.isUndefined(steps.find((candidate) => candidate.name === name)?.with?.["run-id"]);
  }
  const downloads = (await readDesktopReleaseSteps("mines-personal-publish.yml")).filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(
    downloads.filter(
      (step) =>
        step.with?.name?.startsWith("desktop-win-") || step.with?.name?.startsWith("cli-win-"),
    ).length,
    4,
  );
  for (const step of downloads) {
    if (step.with?.name !== "release-source") {
      assert.equal(step.with?.["run-id"], "${{ needs.source.outputs.nonmac_run_id }}");
      assert.equal(step.with?.["github-token"], "${{ github.token }}");
    } else {
      assert.match(step.with?.["run-id"] ?? "", /build[_-]run[_-]id/u);
      assert.equal(step.with?.["github-token"], "${{ github.token }}");
    }
  }
});

it("embeds the host Node executable on native Windows and downloads a target only for cross-builds", async () => {
  const run = (await readDesktopReleaseSteps()).find(
    (step) => step.name === "Build CLI single-executable",
  )?.run;
  assert.isString(run);
  for (const scenario of [
    {
      platform: "win",
      os: "Windows",
      expected: "node apps/server/scripts/cli.ts build-exe --verbose ",
    },
    {
      platform: "win",
      os: "Linux",
      expected: "node apps/server/scripts/cli.ts build-exe --verbose --target win-arm64",
    },
    {
      platform: "mac",
      os: "macOS",
      expected: "node apps/server/scripts/cli.ts build-exe --verbose ",
    },
  ]) {
    const command = run!.replace(/\$\{\{ (.+) \}\}/gu, (_, expression: string) =>
      String(
        NodeVM.runInNewContext(expression, {
          inputs: { platform: scenario.platform, arch: "arm64" },
          runner: { os: scenario.os },
          format: (_template: string, arch: string) => `--target win-${arch}`,
        }),
      ),
    );
    assert.equal(command, scenario.expected);
  }
});

it("normalizes Linux x64 AppImage names and feed references without changing artifact bytes or feed hashes", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-linux-collect-"),
  );
  const run = (await readDesktopReleaseSteps()).find(
    (step) => step.name === "Collect release assets",
  )?.run;
  assert.isString(run);
  const release = NodePath.join(temp.path, "release");
  await NodeFSP.mkdir(release);
  const bytes = Buffer.from("AppImage fixture");
  const hash = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
  const original = "mines-0.1.19-x86_64.AppImage";
  const canonical = "mines-0.1.19-x64.AppImage";
  const feed = `version: 0.1.19\nfiles:\n  - url: ${original}\n    sha512: ${hash}\n    size: ${bytes.length}\npath: ${original}\nsha512: ${hash}\n`;
  await NodeFSP.writeFile(NodePath.join(release, original), bytes);
  await NodeFSP.writeFile(NodePath.join(release, "latest-linux.yml"), feed);
  const inputs: Record<string, string> = {
    platform: "linux",
    arch: "x64",
    release_channel: "stable",
    provenance: "true",
  };
  const script = run!.replace(/\$\{\{ inputs\.([a-z_]+) \}\}/gu, (_, key) => inputs[key] ?? "");
  const result = NodeChildProcess.spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: temp.path,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = NodePath.join(temp.path, "release-publish");
  assert.deepEqual(await NodeFSP.readFile(NodePath.join(output, canonical)), bytes);
  assert.equal(
    await NodeFSP.readFile(NodePath.join(output, "latest-linux.yml"), "utf8"),
    feed.replaceAll(original, canonical),
  );
  assert.deepEqual((await NodeFSP.readdir(output)).sort(), ["latest-linux.yml", canonical]);
});

it("checks out the exact public release source without traversing orphaned vendored gitlinks", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-checkout-"),
  );
  const remote = NodePath.join(temp.path, "remote.git");
  const fixture = NodePath.join(temp.path, "fixture");
  await NodeFSP.mkdir(fixture);
  const git = (args: string[], cwd = fixture) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--bare", remote]);
  git(["init"]);
  await NodeFSP.writeFile(NodePath.join(fixture, "README.md"), "release source fixture");
  git(["add", "README.md"]);
  git([
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${"1".repeat(40)},.repos/orphaned/submodule`,
  ]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", "HEAD:refs/heads/main"]);
  for (const file of [
    "release-desktop.yml",
    "mines-release.yml",
    "mines-personal-release.yml",
    "mines-personal-publish.yml",
    "mines-source-parity.yml",
  ]) {
    const checkouts = (await readDesktopReleaseSteps(file)).filter(
      (step) => step.name === "Checkout" || step.uses?.startsWith("actions/checkout@"),
    );
    for (const [index, checkout] of checkouts.entries()) {
      assert.isString(
        checkout.run,
        `${file}: checkout must avoid action credential cleanup over orphaned gitlinks`,
      );
      const cwd = NodePath.join(temp.path, `${file}-${index}`);
      await NodeFSP.mkdir(cwd);
      const result = NodeChildProcess.spawnSync("bash", ["-euo", "pipefail", "-c", checkout.run!], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_SERVER_URL: temp.path,
          GITHUB_REPOSITORY: "remote",
          CHECKOUT_REF: commit,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
      assert.equal(git(["rev-parse", "HEAD"], cwd), commit);
      assert.equal(
        await NodeFSP.readFile(NodePath.join(cwd, "README.md"), "utf8"),
        "release source fixture",
      );
      assert.isFalse(
        await NodeFSP.stat(NodePath.join(cwd, ".repos")).then(
          () => true,
          () => false,
        ),
      );
    }
  }
});

it("permits unsigned Windows updater artifacts only for the explicit personal release profile", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-personal-release-"),
  );
  const run = (await readDesktopReleaseSteps()).find(
    (step) => step.name === "Build desktop artifact",
  )?.run;
  assert.isString(run);
  const azureNames = [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  ];
  for (const [index, profile] of [
    { personal: false, credentials: false },
    { personal: true, credentials: false },
    { personal: true, credentials: true },
  ].entries()) {
    const capture = NodePath.join(temp.path, `${index}.args`);
    const output = NodePath.join(temp.path, `${index}.outputs`);
    const inputs: Record<string, string> = {
      platform: "win",
      arch: "x64",
      target: "nsis",
      version: "0.1.19",
      provenance: "true",
      personal_release: String(profile.personal),
    };
    const script = run!.replace(/\$\{\{ inputs\.([a-z_]+) \}\}/gu, (_, key) => inputs[key] ?? "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-euo", "pipefail", "-c", `vp() { printf '%s\\n' "$@" > "$CAPTURE"; }\n${script}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(
            azureNames.map((name) => [name, profile.credentials ? "fixture" : ""]),
          ),
          GITHUB_WORKSPACE: temp.path,
          GITHUB_OUTPUT: output,
          CAPTURE: capture,
        },
      },
    );
    if (!profile.personal) {
      assert.equal(result.status, 1, result.stderr);
      assert.include(result.stderr, "Official Mines releases require");
      assert.isFalse(
        await NodeFSP.stat(capture).then(
          () => true,
          () => false,
        ),
      );
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    const args = (await NodeFSP.readFile(capture, "utf8")).trim().split("\n");
    assert.include(args, "--personal-release");
    assert.equal(args.includes("--signed"), profile.credentials);
    assert.include(await NodeFSP.readFile(output, "utf8"), `signed=${String(profile.credentials)}`);
  }
});

it("routes server changes to the dedicated build and server test jobs", () => {
  const packages = readWorkspace();
  const server = packages.find((pkg) => pkg.dir === "apps/server");
  assert.isDefined(server);
  const result = decide(["apps/server/src/backend.ts"], packages, false);
  assert.equal(result.outputs.build, true);
  assert.equal(result.outputs.test_server, true);
  assert.notInclude(result.outputs.test_packages.split(" "), server!.name);
  assert.include(result.affected, "@t3tools/scripts");
  assert.include(result.affected, "@t3tools/evals");
  assert.equal(decide(["apps/web/src/main.tsx"], packages, false).outputs.test_server, false);
});

it("selects existing workspace packages in desktop release and CI workflows", async () => {
  const names = new Set(readWorkspace().map((pkg) => pkg.name));
  names.add("@t3tools/monorepo");
  for (const file of [
    "ci.yml",
    "release.yml",
    "release-desktop.yml",
    "desktop-macos-preview.yml",
  ]) {
    const source = await NodeFSP.readFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(/--filter(?:=| +)['"]?!?([@\w/-]+)/gu)) {
      assert.isTrue(names.has(match[1]!), `${file}: unknown package ${match[1]}`);
    }
  }
});

it("stops macOS release packaging when any Apple signing credential is missing", async () => {
  const run = (await readDesktopReleaseSteps()).find(
    (step) => step.name === "Build desktop artifact",
  )?.run;
  assert.isString(run);
  const script = run!.replace(/\$\{\{ inputs\.([a-z_]+) \}\}/gu, (_, input) =>
    input === "platform" ? "mac" : "",
  );
  const credentials = {
    CSC_LINK: "fixture",
    CSC_KEY_PASSWORD: "fixture",
    APPLE_API_KEY: "fixture",
    APPLE_API_KEY_ID: "fixture",
    APPLE_API_ISSUER: "fixture",
  };
  for (const missing of Object.keys(credentials)) {
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-euo", "pipefail", "-c", `vp() { exit 0; }\n${script}`],
      {
        encoding: "utf8",
        env: { ...process.env, ...credentials, [missing]: "" },
      },
    );
    assert.equal(result.status, 1, missing);
    assert.include(result.stderr, "macOS releases require", missing);
  }
});

it("stages the Cargo resource monitor for macOS release and CLI artifacts", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-release-test-"),
  );
  const cargo = await NodeFSP.readFile(
    new URL("../native/resource-monitor/Cargo.toml", import.meta.url),
    "utf8",
  );
  const name = cargo.match(/^name = "([^"]+)"/mu)?.[1];
  assert.isString(name);
  const inputs: Record<string, string> = {
    platform: "mac",
    rust_target: "aarch64-apple-darwin",
    resource_key: "darwin-arm64",
  };
  const sourceDir = NodePath.join(
    temp.path,
    "native/resource-monitor/target",
    inputs.rust_target!,
    "release",
  );
  await NodeFSP.mkdir(sourceDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(sourceDir, name!), "monitor fixture");
  const steps = await readDesktopReleaseSteps();
  for (const stepName of [
    "Stage resource monitor for the CLI archive",
    "Collect resource monitor",
  ]) {
    const run = steps.find((step) => step.name === stepName)?.run;
    assert.isString(run);
    const script = run!.replace(/\$\{\{ inputs\.([a-z_]+) \}\}/gu, (_, key) => inputs[key] ?? "");
    const result = NodeChildProcess.spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: temp.path,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: temp.path },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const directory of ["cli-resource-monitor", "resource-monitor-publish"]) {
    assert.equal(
      await NodeFSP.readFile(
        NodePath.join(temp.path, directory, inputs.resource_key!, name!),
        "utf8",
      ),
      "monitor fixture",
    );
  }
});
