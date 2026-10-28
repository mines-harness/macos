#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This maintenance command inspects and replaces an application bundle without starting its runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { extractFile } from "@electron/asar";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const APP_ID = "app.mines.desktop";
const PRODUCT_NAME = desktopPackageJson.productName;
const DESTINATION = `/Applications/${PRODUCT_NAME}.app`;
const DEVELOPER_ID_REQUIREMENT =
  "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
const DEVELOPMENT_REQUIREMENT =
  "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.1] exists";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface MacDesktopBundle {
  readonly path: string;
  readonly bundleId: string;
  readonly version: string;
  readonly codeIdentifier: string;
  readonly teamId: string | null;
  readonly developerId: boolean;
  readonly developmentSigned: boolean;
  readonly designatedRequirement: string;
  readonly sourceCommit: string | null;
  readonly payloadSha256: string;
}

export function planMacDesktopInstall(input: {
  readonly source: MacDesktopBundle;
  readonly current?: MacDesktopBundle;
  readonly satisfiesCurrentRequirement?: boolean;
  readonly homeDirectory: string;
  readonly allowAdhoc?: boolean;
  readonly allowDevelopment?: boolean;
  readonly allowIdentityChange?: boolean;
}) {
  for (const bundle of [input.source, ...(input.current ? [input.current] : [])]) {
    if (bundle.bundleId !== APP_ID || bundle.codeIdentifier !== APP_ID) {
      throw new Error(`Unexpected bundle identity at ${bundle.path}; expected ${APP_ID}.`);
    }
  }
  if (
    !input.source.developerId &&
    !(input.allowDevelopment && input.source.developmentSigned) &&
    !input.allowAdhoc
  ) {
    throw new Error(
      "A Developer ID Application signature is required; --allow-development accepts Apple Development signatures, and --allow-adhoc accepts local development bundles.",
    );
  }
  const permissionIdentityChanges = Boolean(input.current && !input.satisfiesCurrentRequirement);
  if (permissionIdentityChanges && !input.allowIdentityChange) {
    throw new Error(
      "The update changes the installed app's permission identity. Review the signer, then use --allow-identity-change for an intentional migration.",
    );
  }
  return {
    destination: DESTINATION,
    rollbackDirectory: NodePath.join(input.homeDirectory, "Library/Caches/mines/desktop-rollbacks"),
    permissionIdentityChanges,
    source: input.source,
    current: input.current ?? null,
  };
}

const decodeInfo = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ CFBundleIdentifier: Schema.String, CFBundleShortVersionString: Schema.String }),
  ),
);
const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ minesCommitHash: Schema.optional(Schema.String) })),
);

async function satisfiesRequirement(appPath: string, requirement: string): Promise<boolean> {
  try {
    await execFile("codesign", ["--verify", `-R=${requirement}`, appPath]);
    return true;
  } catch {
    return false;
  }
}

export async function inspectMacDesktopBundle(appPath: string): Promise<MacDesktopBundle> {
  const path = await NodeFSP.realpath(appPath);
  const plist = await execFile("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    NodePath.join(path, "Contents/Info.plist"),
  ]);
  const info = decodeInfo(plist.stdout);
  await execFile("codesign", ["--verify", "--deep", "--strict", path]);
  const display = await execFile("codesign", ["-dvv", "-r-", path]);
  const signature = `${display.stdout}\n${display.stderr}`;
  const designatedRequirement = signature.match(/^(?:# )?designated => (.+)$/mu)?.[1];
  if (!designatedRequirement) throw new Error(`No designated requirement found at ${path}.`);
  const asarPath = NodePath.join(path, "Contents/Resources/app.asar");
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(asarPath)) hash.update(chunk);
  const metadata = decodePackage(extractFile(asarPath, "package.json").toString("utf8"));
  const teamId = signature.match(/^TeamIdentifier=(.+)$/mu)?.[1];
  return {
    path,
    bundleId: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString,
    codeIdentifier: signature.match(/^Identifier=(.+)$/mu)?.[1] ?? "",
    teamId: teamId && teamId !== "not set" ? teamId : null,
    developerId: await satisfiesRequirement(path, DEVELOPER_ID_REQUIREMENT),
    developmentSigned:
      /^Authority=Apple Development:/mu.test(signature) &&
      (await satisfiesRequirement(path, DEVELOPMENT_REQUIREMENT)),
    designatedRequirement,
    sourceCommit: metadata.minesCommitHash ?? null,
    payloadSha256: hash.digest("hex"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureAppStopped(): Promise<void> {
  const result = await execFile("ps", ["-axo", "command="]);
  if (
    result.stdout
      .split("\n")
      .some((command) => command.trim().startsWith(`${DESTINATION}/Contents/`))
  ) {
    throw new Error(
      `Quit ${PRODUCT_NAME} before replacing its bundle. The installer never terminates a running app.`,
    );
  }
}

async function applyInstall(
  plan: ReturnType<typeof planMacDesktopInstall>,
): Promise<string | null> {
  if (plan.source.path === plan.destination)
    throw new Error("The source is already the installed app.");
  await ensureAppStopped();
  const stage = await NodeFSP.mkdtemp("/Applications/.mines-install-");
  const prepared = NodePath.join(stage, `${PRODUCT_NAME}.app`);
  const previous = NodePath.join(stage, "previous.app");
  let stageOwnsCurrent = false;
  let installed = false;
  let backup: string | null = null;
  try {
    await execFile("ditto", [plan.source.path, prepared]);
    const staged = await inspectMacDesktopBundle(prepared);
    if (staged.payloadSha256 !== plan.source.payloadSha256)
      throw new Error("The source payload changed while staging the update.");
    await ensureAppStopped();
    if (plan.current) {
      const current = await inspectMacDesktopBundle(plan.destination);
      if (current.payloadSha256 !== plan.current.payloadSha256)
        throw new Error("The installed app changed after preflight; run preflight again.");
      await NodeFSP.mkdir(plan.rollbackDirectory, { recursive: true, mode: 0o700 });
      backup = NodePath.join(
        plan.rollbackDirectory,
        `mines-${current.version.replace(/[^0-9A-Za-z.+-]/gu, "_")}-${NodeCrypto.randomUUID()}.zip`,
      );
      await execFile("ditto", [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        plan.destination,
        backup,
      ]);
      await execFile("unzip", ["-t", backup], { maxBuffer: 8 * 1024 * 1024 });
      await ensureAppStopped();
      await NodeFSP.rename(plan.destination, previous);
      stageOwnsCurrent = true;
    }
    await NodeFSP.rename(prepared, plan.destination);
    installed = true;
    await inspectMacDesktopBundle(plan.destination);
    stageOwnsCurrent = false;
    return backup;
  } catch (error) {
    try {
      if (installed) await NodeFSP.rename(plan.destination, NodePath.join(stage, "failed.app"));
      if (stageOwnsCurrent) {
        await NodeFSP.rename(previous, plan.destination);
        stageOwnsCurrent = false;
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Install failed; rollback bundle is preserved at ${previous}.`,
        { cause: restoreError },
      );
    }
    throw error;
  } finally {
    if (!stageOwnsCurrent) await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if ((await Effect.runPromise(HostProcess.Platform)) !== "darwin")
    throw new Error("This installer supports macOS; Windows uses the NSIS installer.");
  const args = process.argv.slice(2);
  const allowedFlags = new Set([
    "--audit",
    "--apply",
    "--allow-development",
    "--allow-adhoc",
    "--allow-identity-change",
  ]);
  for (const arg of args)
    if (arg.startsWith("--") && !allowedFlags.has(arg)) throw new Error(`Unknown option: ${arg}`);
  if (args.includes("--audit")) {
    if (args.length !== 1) throw new Error("Use --audit alone.");
    const bundles: Array<MacDesktopBundle | { path: string; error: string }> = [];
    for (const directory of ["/Applications", NodePath.join(NodeOS.homedir(), "Applications")]) {
      if (!(await exists(directory))) continue;
      for (const entry of await NodeFSP.readdir(directory)) {
        if (!entry.toLowerCase().includes("mines") || !entry.endsWith(".app")) continue;
        const path = NodePath.join(directory, entry);
        try {
          bundles.push(await inspectMacDesktopBundle(path));
        } catch (error) {
          bundles.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ destination: DESTINATION, bundles }, null, 2)}\n`);
    return;
  }
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (paths.length !== 1)
    throw new Error(
      "Usage: node scripts/install-desktop.ts <source.app> [--apply] [--allow-development] [--allow-adhoc] [--allow-identity-change], or --audit. Without --apply, only preflight runs.",
    );
  const source = await inspectMacDesktopBundle(paths[0]!);
  const current = (await exists(DESTINATION))
    ? await inspectMacDesktopBundle(DESTINATION)
    : undefined;
  const plan = planMacDesktopInstall({
    source,
    ...(current
      ? {
          current,
          satisfiesCurrentRequirement: await satisfiesRequirement(
            source.path,
            current.designatedRequirement,
          ),
        }
      : {}),
    homeDirectory: NodeOS.homedir(),
    allowAdhoc: args.includes("--allow-adhoc"),
    allowDevelopment: args.includes("--allow-development"),
    allowIdentityChange: args.includes("--allow-identity-change"),
  });
  const rollbackArchive = args.includes("--apply") ? await applyInstall(plan) : null;
  process.stdout.write(
    `${JSON.stringify({ ...plan, applied: args.includes("--apply"), rollbackArchive }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
