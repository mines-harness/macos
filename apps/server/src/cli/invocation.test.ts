import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import {
  resolveCliCommand,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  it.effect("does not suggest downloading an upstream package for this fork", () =>
    Effect.gen(function* () {
      for (const entry of [
        "/npm/_npx/x/node_modules/t3/bin/t3.mjs",
        "/pnpm/dlx/x/t3/dist/bin.mjs",
        "/.bun/install/cache/t3/dist/bin.mjs",
      ]) {
        expect(
          yield* resolveCliCommand("serve").pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Environment, {}),
          ),
        ).toBe("mines serve");
      }
    }),
  );
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "mines"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs";
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo mines browser setup",
      );
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" mines browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/t3/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe('sudo env "PATH=$PATH" mines browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher instead of an unrelated mines on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "mines");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { MINES_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        `sudo '${shim}' browser setup`,
      );

      expect(
        yield* rootCommand({
          node: "/opt/t3/t3",
          entry: "/opt/t3/t3",
          executable: true,
        }),
      ).toBe("sudo /opt/t3/mines browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { MINES_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" mines browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "mines.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.t3"]).pipe(
          Effect.provideService(HostProcess.ExecutablePath, "C:\\Program Files\\mines\\mines.exe"),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\mines\\mines.exe",
            "C:\\Program Files\\mines\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { MINES_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.t3"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'mines doctor "--base-dir" "C:\\Users\\Jane Doe\\.t3"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", ["--base-dir", "C:\\T3\\\u201CArchive\u201D"]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\mines.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\mines.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('mines doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { MINES_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.t3'$/,
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("does not advertise upstream runner caches as mines update channels", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".t3/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const relative of [
        "npm/_npx/hash/node_modules/t3/dist/bin.mjs",
        "npm/_npx/hash/node_modules/t3/bin/t3.mjs",
        "pnpm/dlx/hash/node_modules/t3/dist/bin.mjs",
        ".bun/install/cache/t3/dist/bin.mjs",
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "../package.json"),
          `{"name":"mines","version":"${packageJson.version}","bin":{"mines":"./bin/t3.mjs"}}`,
        );
        const launchedBy = entry.endsWith("t3.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { MINES_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toBeNull();
      }
    }),
  );

  it.effect("does not advertise a valid upstream npm global as a mines update channel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/t3");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"mines","version":"0.0.45","bin":{"mines":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toBeNull();
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated mines command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("does not infer mines releases from upstream npm launcher versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const launcher = path.join(packageRoot, "bin/t3.mjs");
      const executable = path.join(root, ".t3/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/t3"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { MINES_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, null],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"mines","version":"${version}","bin":{"mines":"./bin/t3.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/t3/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".t3/runtime/0.0.45/t3",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
