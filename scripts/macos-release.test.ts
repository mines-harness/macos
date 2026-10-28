// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
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
                  with: Schema.optional(Schema.Struct({ script: Schema.optional(Schema.String) })),
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
