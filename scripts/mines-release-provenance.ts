#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Release scripts inspect Git and hash packaged artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import config from "../.github/mines-release.json" with { type: "json" };
import { parseUpdateManifest } from "./lib/update-manifest.ts";

const ReleaseSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  repository: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  lockfileSha256: Schema.String,
  version: Schema.String,
  channel: Schema.Literals(["stable", "nightly", "preview"]),
  runUrl: Schema.String,
});
export type ReleaseSource = typeof ReleaseSourceSchema.Type;

const ReleaseAssetSchema = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  sha512: Schema.String,
  size: Schema.Number,
});
const ReleaseTargetSchema = Schema.Struct({
  source: ReleaseSourceSchema,
  target: Schema.String,
  assets: Schema.Array(ReleaseAssetSchema),
});

const decodeReleaseSource = Schema.decodeUnknownSync(ReleaseSourceSchema);
const decodeReleaseTarget = Schema.decodeUnknownSync(ReleaseTargetSchema);

const targets = [
  "mac-arm64",
  "mac-x64",
  "linux-arm64",
  "linux-x64",
  "win-arm64",
  "win-x64",
] as const;
const sourceFields = [
  "schemaVersion",
  "repository",
  "commit",
  "tree",
  "lockfileSha256",
  "version",
  "channel",
  "runUrl",
] as const;

const sha256 = (input: NodeCrypto.BinaryLike) =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");
async function fileDigest(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  const updaterHash = NodeCrypto.createHash("sha512");
  for await (const bytes of NodeFS.createReadStream(file)) {
    hash.update(bytes);
    updaterHash.update(bytes);
  }
  return {
    sha256: hash.digest("hex"),
    sha512: updaterHash.digest("base64"),
    size: (await NodeFSP.stat(file)).size,
  };
}

const readSource = async (file: string) =>
  decodeReleaseSource(JSON.parse(await NodeFSP.readFile(file, "utf8")));

function validateSource(source: ReleaseSource) {
  if (
    source.repository !== config.sourceRepository ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    !/^[a-f0-9]{40}$/.test(source.tree) ||
    !/^[a-f0-9]{64}$/.test(source.lockfileSha256)
  ) {
    throw new Error(
      "Release provenance must identify the canonical source commit, tree, and lockfile.",
    );
  }
  const suffix = source.channel === "stable" ? "" : `-${source.channel}\\.\\d{8}\\.\\d+`;
  if (!new RegExp(`^\\d+\\.\\d+\\.\\d+${suffix}$`).test(source.version)) {
    throw new Error(`Release version ${source.version} does not match channel ${source.channel}.`);
  }
}

function validateTargetFiles(source: ReleaseSource, target: string, names: ReadonlySet<string>) {
  if (!(targets as readonly string[]).includes(target))
    throw new Error(`Unknown release target: ${target}`);
  const [platform, arch] = target.split("-");
  const extension = platform === "mac" ? "dmg" : platform === "win" ? "exe" : "AppImage";
  if (!names.has(`mines-${source.version}-${arch}.${extension}`)) {
    throw new Error(`Missing desktop artifact for ${target}.`);
  }
  // Node SEA does not support macOS x64; its Electron desktop remains supported.
  if (
    target !== "mac-x64" &&
    !names.has(
      `mines-${source.version}-${platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`,
    )
  ) {
    throw new Error(
      `Missing matching CLI archive for ${target}; desktop SSH bootstrap pins ${source.version}.`,
    );
  }
  if (
    source.channel === "preview" &&
    [...names].some((name) => name.endsWith(".yml") || name.endsWith(".blockmap"))
  ) {
    throw new Error("Preview releases cannot contain updater metadata.");
  }
  if (source.channel !== "preview") {
    if (platform === "mac" && !names.has(`mines-${source.version}-${arch}.zip`)) {
      throw new Error(
        `Missing macOS updater ZIP for ${target}; a DMG alone cannot update the installed app.`,
      );
    }
    if (
      (platform === "mac" || platform === "win") &&
      !names.has(`mines-${source.version}-${arch}.${platform === "mac" ? "zip" : "exe"}.blockmap`)
    ) {
      throw new Error(`Missing updater blockmap for ${target}.`);
    }
    const feed = source.channel === "stable" ? "latest" : "nightly";
    if (![...names].some((name) => name.startsWith(`${feed}`) && name.endsWith(".yml"))) {
      throw new Error(`Missing ${feed} updater feed for ${target}.`);
    }
  }
}

function validateUpdaterManifest(
  source: ReleaseSource,
  name: string,
  raw: string,
  assets: ReadonlyMap<string, typeof ReleaseAssetSchema.Type>,
) {
  const manifest = parseUpdateManifest(raw, name, "Mines");
  if (manifest.version !== source.version)
    throw new Error(`Updater feed version mismatch: ${name}`);
  for (const file of manifest.files) {
    const asset = assets.get(file.url);
    if (!asset || asset.size !== file.size || asset.sha512 !== file.sha512)
      throw new Error(`Updater feed references an absent or different artifact: ${file.url}`);
  }
}

export async function recordReleaseTarget(
  source: ReleaseSource,
  target: string,
  directories: readonly string[],
) {
  validateSource(source);
  const assets = new Map<string, typeof ReleaseAssetSchema.Type>();
  const manifests: { name: string; raw: string }[] = [];
  for (const directory of directories) {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "builder-debug.yml" || entry.name.endsWith(".json"))
        continue;
      const asset = {
        name: entry.name,
        ...(await fileDigest(NodePath.join(directory, entry.name))),
      };
      if (assets.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
      assets.set(entry.name, asset);
      if (entry.name.endsWith(".yml"))
        manifests.push({
          name: entry.name,
          raw: await NodeFSP.readFile(NodePath.join(directory, entry.name), "utf8"),
        });
    }
  }
  validateTargetFiles(source, target, new Set(assets.keys()));
  for (const manifest of manifests)
    validateUpdaterManifest(source, manifest.name, manifest.raw, assets);
  return {
    source,
    target,
    assets: [...assets.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function verifyReleaseTargets(source: ReleaseSource, directory: string) {
  validateSource(source);
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^provenance-.*\.json$/.test(entry.name))
      .map(async (entry) =>
        decodeReleaseTarget(
          JSON.parse(await NodeFSP.readFile(NodePath.join(directory, entry.name), "utf8")),
        ),
      ),
  );
  const missing = targets.filter((target) => !records.some((record) => record.target === target));
  if (missing.length > 0) throw new Error(`Missing release targets: ${missing.join(", ")}`);
  if (records.length !== targets.length)
    throw new Error("Duplicate or unknown release target provenance.");
  const assets = new Map<string, typeof ReleaseAssetSchema.Type>();
  for (const record of records) {
    if (sourceFields.some((field) => record.source[field] !== source[field]))
      throw new Error(
        `${record.target} was built from a different source, version, or workflow run.`,
      );
    validateTargetFiles(source, record.target, new Set(record.assets.map((asset) => asset.name)));
    for (const asset of record.assets) {
      if (
        asset.name !== NodePath.basename(asset.name) ||
        asset.name === "." ||
        asset.name === ".." ||
        !/^[a-f0-9]{64}$/.test(asset.sha256)
      )
        throw new Error(`Invalid release asset: ${asset.name}`);
      if (assets.has(asset.name)) throw new Error(`Duplicate release asset: ${asset.name}`);
      const digest = await fileDigest(NodePath.join(directory, asset.name));
      if (
        digest.sha256 !== asset.sha256 ||
        digest.sha512 !== asset.sha512 ||
        digest.size !== asset.size
      )
        throw new Error(`Release asset hash mismatch: ${asset.name}`);
      assets.set(asset.name, asset);
    }
    const targetAssets = new Map(record.assets.map((asset) => [asset.name, asset]));
    for (const asset of record.assets) {
      if (asset.name.endsWith(".yml"))
        validateUpdaterManifest(
          source,
          asset.name,
          await NodeFSP.readFile(NodePath.join(directory, asset.name), "utf8"),
          targetAssets,
        );
    }
  }
  const unrecorded = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.endsWith(".json") &&
      entry.name !== "SHA256SUMS" &&
      !assets.has(entry.name),
  );
  if (unrecorded.length > 0)
    throw new Error(
      `Unrecorded release assets: ${unrecorded.map((entry) => entry.name).join(", ")}`,
    );
  return {
    source,
    targets: records.map((record) => record.target).sort(),
    assets: [...assets.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function main() {
  const { positionals, values } = NodeUtil.parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      version: { type: "string" },
      channel: { type: "string" },
      target: { type: "string" },
      directory: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  if (positionals[0] === "source") {
    const version = values.version ?? config.version;
    const channel = values.channel ?? "stable";
    const git = (args: readonly string[]) =>
      NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
    if (git(["status", "--porcelain", "--untracked-files=no"]))
      throw new Error("Capture release provenance before modifying the clean source checkout.");
    const source = decodeReleaseSource({
      schemaVersion: 1,
      repository: process.env.GITHUB_REPOSITORY ?? config.sourceRepository,
      commit: git(["rev-parse", "HEAD"]),
      tree: git(["rev-parse", "HEAD^{tree}"]),
      lockfileSha256: sha256(await NodeFSP.readFile("pnpm-lock.yaml")),
      version,
      channel,
      runUrl: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${config.sourceRepository}/actions/runs/${process.env.GITHUB_RUN_ID ?? "local"}`,
    });
    validateSource(source);
    await NodeFSP.writeFile(
      values.output ?? "release-source.json",
      `${JSON.stringify(source, null, 2)}\n`,
    );
  } else if (positionals[0] === "target") {
    if (!values.source || !values.target || !values.directory?.length || !values.output)
      throw new Error("target requires --source, --target, --directory, and --output.");
    const record = await recordReleaseTarget(
      await readSource(values.source),
      values.target,
      values.directory,
    );
    await NodeFSP.writeFile(values.output, `${JSON.stringify(record, null, 2)}\n`);
  } else if (positionals[0] === "verify") {
    if (!values.source || values.directory?.length !== 1)
      throw new Error("verify requires --source and one --directory.");
    const report = await verifyReleaseTargets(
      await readSource(values.source),
      values.directory[0]!,
    );
    await NodeFSP.writeFile(
      values.output ?? "release-report.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.stdout.write(
      `Verified ${report.targets.length} targets and ${report.assets.length} artifacts at ${report.source.commit}.\n`,
    );
  } else {
    throw new Error("Expected source, target, or verify.");
  }
}

if (import.meta.main) await main();
