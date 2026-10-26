// @effect-diagnostics nodeBuiltinImport:off - Inspect the actual gzip archive for nonportable extended metadata.
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, live } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { cliArchiveTarArguments } from "./build-cli-archive.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";

live("CLI archives omit filesystem metadata that Linux tar cannot read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "mines-archive-metadata-" });
    const content = path.join(scratch, "runtime");
    const executable = path.join(content, "mines");
    yield* fs.makeDirectory(content);
    yield* fs.writeFileString(executable, "#!/bin/sh\nexit 0\n");
    if (platform === "darwin") {
      const xattr = yield* spawner.spawn(
        ChildProcess.make("xattr", ["-w", "com.apple.mines-test", "metadata", executable]),
      );
      assert.strictEqual(Number(yield* xattr.exitCode), 0);
    }
    const archive = path.join(scratch, "runtime.tar.gz");
    const tarCommand = platform === "win32" ? windowsSystemTar() : "tar";
    const tar = yield* spawner.spawn(
      ChildProcess.make(tarCommand, cliArchiveTarArguments(archive, scratch, "runtime", platform), {
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    assert.strictEqual(Number(yield* tar.exitCode), 0);
    const contents = NodeZlib.gunzipSync(yield* fs.readFile(archive)).toString("utf8");
    assert.notInclude(contents, "LIBARCHIVE.xattr.");
    assert.notInclude(contents, "SCHILY.xattr.");
    assert.include(contents, "#!/bin/sh\nexit 0\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);
