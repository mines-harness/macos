import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import packageJson from "../../package.json" with { type: "json" };

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Struct({ mines: Schema.String })),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

/**
 * `MINES_NPM_LAUNCHER_PATH` is inherited by child shells, so accept it only for this package
 * version to avoid claiming another `mines` invocation is the npm install.
 */
export const resolveEntryPath = Effect.gen(function* () {
  const npmLauncher = (yield* HostProcess.Environment).MINES_NPM_LAUNCHER_PATH?.trim();
  if (npmLauncher) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifest = yield* fs
      .readFileString(path.join(path.dirname(npmLauncher), "../package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest), Effect.option);
    if (
      Option.isSome(manifest) &&
      manifest.value.name === "mines" &&
      manifest.value.version === packageJson.version
    ) {
      return npmLauncher;
    }
  }
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? "";
});

// An upstream npm package name cannot establish ownership of a mines release.
export const resolveServerInstallation = Effect.succeed<ServerInstallation | null>(null);

export const resolveCliCommand = (subcommand: string) => Effect.succeed(`mines ${subcommand}`);

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/** Script installs have no single launcher; desktop shims and standalone binaries do. */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* HostProcess.Environment).MINES_CLI_PATH?.trim();
  if (shim && (yield* fs.exists(shim).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * Uses this install's absolute launcher path or `mines` on PATH.
 * Arguments are quoted for POSIX shells or PowerShell on Windows.
 */
export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const withArgs = (prefix: string) =>
    [prefix, ...args.map((arg) => hostShellWord(platform, arg))].join(" ");
  const command = yield* resolveCliCommand(subcommand);
  const launcher = yield* resolveInstallLauncher;
  if (Option.isNone(launcher)) return { command: withArgs(command), launcher: false };
  // PowerShell runs a quoted path only through the call operator.
  const quoted = hostShellWord(platform, launcher.value);
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return { command: withArgs(`${call} ${subcommand}`), launcher: true };
});

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it a global `mines`, so the command
 * carries PATH through unless Node is on root's PATH too. An absolute launcher
 * needs neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
