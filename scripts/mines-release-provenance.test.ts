// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  recordReleaseTarget,
  verifyReleaseTargets,
  type ReleaseSource,
} from "./mines-release-provenance.ts";

const source: ReleaseSource = {
  schemaVersion: 1,
  repository: "mines-harness/macos",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  lockfileSha256: "3".repeat(64),
  version: "0.1.19",
  channel: "stable",
  runUrl: "https://github.com/mines-harness/macos/actions/runs/123",
};

it("refuses a desktop release without the CLI archive its SSH bootstrap pins", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-release-"),
  );
  await NodeFSP.writeFile(NodePath.join(temp.path, "mines-0.1.19-arm64.dmg"), "desktop");
  await NodeAssert.rejects(recordReleaseTarget(source, "mac-arm64", [temp.path]), /CLI archive/);
});

it("rejects an incomplete platform matrix before publication", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-release-"),
  );
  await NodeAssert.rejects(verifyReleaseTargets(source, temp.path), /Missing release targets/);
});

it("refuses a DMG-only macOS release because the in-app updater needs its ZIP and feed", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-release-"),
  );
  await NodeFSP.writeFile(NodePath.join(temp.path, "mines-0.1.19-arm64.dmg"), "desktop");
  await NodeFSP.writeFile(NodePath.join(temp.path, "mines-0.1.19-darwin-arm64.tar.gz"), "cli");
  await NodeAssert.rejects(recordReleaseTarget(source, "mac-arm64", [temp.path]), /updater ZIP/);
});

it("verifies every target and detects a replaced archive or a different source commit", async () => {
  await using temp = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "mines-release-"),
  );
  for (const target of [
    "mac-arm64",
    "mac-x64",
    "linux-arm64",
    "linux-x64",
    "win-arm64",
    "win-x64",
  ]) {
    const [platform, arch] = target.split("-");
    const ext = platform === "mac" ? "dmg" : platform === "win" ? "exe" : "AppImage";
    const stage = NodePath.join(temp.path, target);
    await NodeFSP.mkdir(stage);
    await NodeFSP.writeFile(NodePath.join(stage, `mines-0.1.19-${arch}.${ext}`), target);
    if (target !== "mac-x64") {
      await NodeFSP.writeFile(
        NodePath.join(
          stage,
          `mines-0.1.19-${platform === "mac" ? "darwin" : platform === "win" ? "win32" : platform}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`,
        ),
        `cli ${target}`,
      );
    }
    const updaterFile = `mines-0.1.19-${arch}.${platform === "mac" ? "zip" : ext}`;
    const updaterBytes = platform === "mac" ? `updater ${target}` : target;
    if (platform === "mac")
      await NodeFSP.writeFile(NodePath.join(stage, updaterFile), updaterBytes);
    if (platform !== "linux")
      await NodeFSP.writeFile(NodePath.join(stage, `${updaterFile}.blockmap`), "blockmap");
    const updaterHash = NodeCrypto.createHash("sha512").update(updaterBytes).digest("base64");
    await NodeFSP.writeFile(
      NodePath.join(stage, `latest-${platform}-${arch}.yml`),
      `version: 0.1.19\nfiles:\n  - url: ${updaterFile}\n    sha512: ${updaterHash}\n    size: ${Buffer.byteLength(updaterBytes)}\nreleaseDate: '2026-10-29T00:00:00.000Z'\n`,
    );
    const record = await recordReleaseTarget(source, target, [stage]);
    await NodeFSP.writeFile(
      NodePath.join(temp.path, `provenance-${target}.json`),
      JSON.stringify(record),
    );
    for (const asset of record.assets) {
      await NodeFSP.copyFile(
        NodePath.join(stage, asset.name),
        NodePath.join(temp.path, asset.name),
      );
    }
  }
  const result = await verifyReleaseTargets(source, temp.path);
  assert.equal(result.targets.length, 6);
  assert.equal(
    result.assets.filter((asset) =>
      /(?:darwin|linux|win32)-(?:arm64|x64)\.(?:tar\.gz|zip)$/.test(asset.name),
    ).length,
    5,
  );

  const archive = NodePath.join(temp.path, "mines-0.1.19-linux-x64.tar.gz");
  await NodeFSP.writeFile(archive, "replacement");
  await NodeAssert.rejects(verifyReleaseTargets(source, temp.path), /hash mismatch/);
  await NodeFSP.writeFile(archive, "cli linux-x64");

  const recordPath = NodePath.join(temp.path, "provenance-mac-arm64.json");
  const record = JSON.parse(await NodeFSP.readFile(recordPath, "utf8"));
  record.source.commit = "4".repeat(40);
  await NodeFSP.writeFile(recordPath, JSON.stringify(record));
  await NodeAssert.rejects(verifyReleaseTargets(source, temp.path), /different source/);
});
