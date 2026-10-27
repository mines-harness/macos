// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

async function readDesktopReleaseSteps() {
  const workflow = Schema.decodeSync(
    fromYaml(
      Schema.Struct({
        jobs: Schema.Record(
          Schema.String,
          Schema.Struct({
            steps: Schema.Array(
              Schema.Struct({
                name: Schema.optional(Schema.String),
                run: Schema.optional(Schema.String),
              }),
            ),
          }),
        ),
      }),
    ),
  )(
    await NodeFSP.readFile(
      new URL("../.github/workflows/release-desktop.yml", import.meta.url),
      "utf8",
    ),
  );
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

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
