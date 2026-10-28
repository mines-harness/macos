// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

const script = new URL("./check-changed.ts", import.meta.url);

async function fixture(directory: string) {
  const write = async (path: string, value: string) => {
    const absolute = NodePath.join(directory, path);
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, value);
  };
  await write("scripts/check-changed.ts", await NodeFSP.readFile(script, "utf8"));
  await write(
    "package.json",
    JSON.stringify({ type: "module", scripts: { "knip:check": "knip" } }),
  );
  await write(".gitignore", "node_modules/\n.generated/\n");
  await write(
    ".github/scripts/ci-changes.cjs",
    "exports.readWorkspace = () => [];\n" +
      "exports.decide = () => ({ affected: [], outputs: {} });\n",
  );
  await write("fixture.md", "Original\n");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  await write(
    "node_modules/vite-plus/bin/vp",
    "import fs from 'node:fs';\n" +
      "fs.appendFileSync(process.env.FIXTURE_COMMANDS, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
  );
  const commands = NodePath.join(directory, "node_modules/commands.jsonl");
  const gitExecutable = NodeChildProcess.execFileSync(
    HostProcess.Platform.defaultValue() === "win32" ? "where.exe" : "which",
    ["git"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/u)[0]!;
  return {
    write,
    git,
    run: (environment: Record<string, string> = {}) =>
      NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: NodePath.dirname(gitExecutable),
          FIXTURE_COMMANDS: commands,
          ...environment,
        },
      }),
    commands: async () =>
      (await NodeFSP.readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

it("runs the checkout's Vite Plus CLI when no shell shim is available", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-check-changed-"),
  );
  const repo = await fixture(temp.path);
  await repo.write("fixture.ts", "export const value = 1;\n");
  const result = repo.run({ MINES_CHECK_JOBS: "1" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(
    (await repo.commands()).map((command) => command[0]),
    ["fmt", "lint", "exec"],
  );
});

it("accepts a deletion with no runnable checks", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-check-changed-"),
  );
  const repo = await fixture(temp.path);
  await NodeFSP.unlink(NodePath.join(temp.path, "fixture.md"));
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.include(result.stdout, "check:changed summary");
});

it("invalidates a passing check when ignored generated inputs change", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-check-changed-"),
  );
  const repo = await fixture(temp.path);
  await repo.write("fixture.md", "Changed\n");
  await repo.write(".generated/types.d.ts", "declare const value: 1;\n");
  await NodeFSP.symlink(temp.path, NodePath.join(temp.path, ".generated/loop"), "junction");
  const first = repo.run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const cached = repo.run();
  assert.equal(cached.status, 0, cached.stderr + cached.stdout);
  assert.include(cached.stdout, "Nothing changed since the last passing run.");
  await repo.write(".generated/types.d.ts", "declare const value: 2;\n");
  const changed = repo.run();
  assert.equal(changed.status, 0, changed.stderr + changed.stdout);
  assert.notInclude(changed.stdout, "Nothing changed since the last passing run.");
  assert.equal((await repo.commands()).length, 2);
});
