// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_MINES_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `mines-${VERSION}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "release", stem, "mines"),
    '#!/bin/sh\necho "stub $* launcher=$MINES_NPM_LAUNCHER_PATH"\nexit 7\n',
  );
  yield* fs.chmod(path.join(root, "release", stem, "mines"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: process.env.PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    corruptChecksum: () => {
      checksum = "0".repeat(64);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "downloads from the canonical release without configuration and preserves explicit repositories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mines-npm-default-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });
        const release = yield* serveFakeRelease(root);
        const launcher = path.join(output.packageDir, "bin/mines.mjs");
        const preload = path.join(root, "local-release.mjs");
        yield* fs.writeFileString(
          preload,
          [
            'import fs from "node:fs";',
            "const fetchRelease = globalThis.fetch;",
            "globalThis.fetch = (input, options) => {",
            '  const url = typeof input === "string" ? input : input.url;',
            "  fs.appendFileSync(process.env.MINES_FIXTURE_REQUESTS, `${url}\\n`);",
            "  const expected = process.env.MINES_FIXTURE_RELEASE_BASE;",
            "  if (!url.startsWith(`${expected}/`)) throw new Error(`Unexpected release request: ${url}`);",
            "  return fetchRelease(process.env.MINES_FIXTURE_LOCAL_BASE + url.slice(expected.length), options);",
            "};",
          ].join("\n"),
        );
        const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
        for (const repository of [undefined, "mines-harness/cli", "example/private-mines"]) {
          const home = path.join(root, repository?.replaceAll("/", "-") ?? "default");
          const requests = `${home}.requests`;
          const base = `https://github.com/${repository ?? DEFAULT_MINES_RELEASE_REPOSITORY}/releases/download`;
          const env = {
            PATH: process.env.PATH,
            MINES_HOME: home,
            ...(repository === undefined ? {} : { MINES_CLI_UPDATE_REPOSITORY: repository }),
            T3CODE_CLI_RELEASE_BASE_URL: "https://old.example.test",
            MINES_FIXTURE_RELEASE_BASE: base,
            MINES_FIXTURE_LOCAL_BASE: release.baseUrl,
            MINES_FIXTURE_REQUESTS: requests,
          };
          const args = ["--import", preload, launcher, "--version"];
          const installed = yield* run(process.execPath, args, { cwd: root, env });
          assert.equal(installed.exitCode, 7, installed.stderr);
          assert.include(installed.stdout, "stub --version launcher=");
          assert.deepStrictEqual((yield* fs.readFileString(requests)).trim().split("\n"), [
            `${base}/v${VERSION}/SHA256SUMS`,
            `${base}/v${VERSION}/mines-${VERSION}-${key}.tar.gz`,
          ]);
          assert.equal(
            (yield* fs.readFileString(
              path.join(home, "runtime/versions", VERSION, ".install-complete"),
            )).trim(),
            VERSION,
          );
          const count = release.requests.length;
          const cached = yield* run(process.execPath, args, { cwd: root, env });
          assert.equal(cached.exitCode, 7, cached.stderr);
          assert.equal(release.requests.length, count);
        }
        const invalidSources = [
          { MINES_CLI_UPDATE_REPOSITORY: "pingdotgg/t3code" },
          { MINES_CLI_UPDATE_REPOSITORY: "invalid/repo/path" },
          { MINES_CLI_RELEASE_BASE_URL: "https://github.com/pingdotgg/t3code/releases/download" },
          { MINES_CLI_RELEASE_BASE_URL: "https://user:secret@mirror.example/download" },
          { MINES_CLI_RELEASE_BASE_URL: "http://mirror.example/download" },
        ];
        for (const [index, source] of invalidSources.entries()) {
          const requests = path.join(root, `rejected-${index}.requests`);
          const home = path.join(root, `rejected-${index}`);
          yield* fs.writeFileString(requests, "");
          const result = yield* run(
            process.execPath,
            ["--import", preload, launcher, "--version"],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                MINES_HOME: home,
                MINES_FIXTURE_RELEASE_BASE: `https://github.com/${DEFAULT_MINES_RELEASE_REPOSITORY}/releases/download`,
                MINES_FIXTURE_LOCAL_BASE: release.baseUrl,
                MINES_FIXTURE_REQUESTS: requests,
                ...source,
              },
            },
          );
          assert.equal(result.exitCode, 1, result.stderr);
          assert.include(result.stderr, "MINES_CLI_UPDATE_REPOSITORY");
          assert.equal(yield* fs.readFileString(requests), "");
          assert.isFalse(yield* fs.exists(home));
        }
      }),
  );
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mines-npm-launcher-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "mines");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.repository, {
          type: "git",
          url: `https://github.com/${DEFAULT_MINES_RELEASE_REPOSITORY}`,
          directory: "apps/server",
        });
        assert.deepStrictEqual(manifest.bin, { mines: "./bin/mines.mjs" });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);

        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: process.env.PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const rejected = yield* run(
          process.execPath,
          [path.join(packageDir, "bin/mines.mjs"), "--version"],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              MINES_HOME: path.join(root, "rejected"),
              MINES_CLI_UPDATE_REPOSITORY: "pingdotgg/t3code",
            },
          },
        );
        assert.equal(rejected.exitCode, 1);
        assert.include(rejected.stderr, "MINES_CLI_UPDATE_REPOSITORY");
        assert.isFalse(yield* fs.exists(path.join(root, "rejected")));

        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          MINES_HOME: home,
          MINES_CLI_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/mines.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(
          first.stdout.trim(),
          `stub serve a b launcher=${yield* fs.realPath(launcher)}`,
          first.stderr,
        );
        assert.equal(first.exitCode, 7);
        const versionDir = path.join(home, "runtime/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/versions"))).sort(),
          [VERSION],
        );

        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst);

        const ipcServer = path.join(home, "runtime/versions", VERSION, "mines");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const service = NodeChildProcess.fork(launcher, ["__service-preflight", "a b"], {
          env,
          silent: true,
        });
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(service, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(service, "message");
          service.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(service, "exit");
          service.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, MINES_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 7, one.stderr);
        assert.equal(two.exitCode, 7, two.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(raceHome, "runtime/versions")), [
          VERSION,
        ]);

        release.corruptChecksum();
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, MINES_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/versions")),
          [],
        );
      }),
  );
});
