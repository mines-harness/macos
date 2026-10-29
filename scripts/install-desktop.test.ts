import { assert, it } from "@effect/vitest";
import { createPackage } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  inspectMacDesktopPayload,
  planMacDesktopInstall,
  type MacDesktopBundle,
} from "./install-desktop.ts";

it.effect("reads the new payload metadata after an archive replaces the same install path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mines-installer-asar-cache-" });
      const previous = path.join(root, "previous");
      const next = path.join(root, "next");
      yield* fs.makeDirectory(previous);
      yield* fs.makeDirectory(next);
      yield* fs.writeFileString(
        path.join(previous, "package.json"),
        JSON.stringify({ minesCommitHash: "a".repeat(40) }),
      );
      yield* fs.writeFileString(
        path.join(next, "package.json"),
        JSON.stringify({
          minesCommitHash: "b".repeat(40),
          version: "0.1.21",
          description: "A differently sized package header for the replacement payload",
        }),
      );
      const installed = path.join(root, "app.asar");
      const replacement = path.join(root, "replacement.asar");
      yield* Effect.tryPromise(() => createPackage(previous, installed));
      yield* Effect.tryPromise(() => createPackage(next, replacement));
      const oldPayload = yield* Effect.tryPromise(() => inspectMacDesktopPayload(installed));
      const expected = yield* Effect.tryPromise(() => inspectMacDesktopPayload(replacement));
      assert.equal(oldPayload.sourceCommit, "a".repeat(40));
      yield* fs.rename(replacement, installed);
      const actual = yield* Effect.tryPromise(() => inspectMacDesktopPayload(installed));
      assert.deepStrictEqual(actual, expected);
      assert.equal(actual.sourceCommit, "b".repeat(40));
      assert.notEqual(actual.payloadSha256, oldPayload.payloadSha256);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const bundle = (overrides: Partial<MacDesktopBundle> = {}): MacDesktopBundle => ({
  path: "/build/mines (Beta).app",
  bundleId: "app.mines.desktop",
  version: "0.2.0",
  codeIdentifier: "app.mines.desktop",
  teamId: "ABC1234567",
  developerId: true,
  developmentSigned: false,
  designatedRequirement: 'identifier "app.mines.desktop" and anchor apple generic',
  sourceCommit: "a".repeat(40),
  payloadSha256: "b".repeat(64),
  ...overrides,
});

it("upgrades one canonical installation and stores rollback archives outside Applications", () => {
  const plan = planMacDesktopInstall({
    source: bundle({ path: "/build/mines (Nightly).app" }),
    current: bundle({ version: "0.1.0" }),
    satisfiesCurrentRequirement: true,
    homeDirectory: "/Users/alice",
  });
  assert.equal(plan.destination, "/Applications/mines (Beta).app");
  assert.equal(plan.rollbackDirectory, "/Users/alice/Library/Caches/mines/desktop-rollbacks");
  assert.isFalse(plan.permissionIdentityChanges);
});

it("refuses a different bundle identity even when allowing a signer transition", () => {
  assert.throws(
    () =>
      planMacDesktopInstall({
        source: bundle({ bundleId: "other.app" }),
        homeDirectory: "/Users/alice",
        allowIdentityChange: true,
      }),
    /bundle identity/,
  );
});

it("refuses an unsigned or ad-hoc app unless explicitly requested for local development", () => {
  assert.throws(
    () =>
      planMacDesktopInstall({
        source: bundle({ developerId: false, teamId: null }),
        homeDirectory: "/Users/alice",
      }),
    /Developer ID/,
  );
});

it("refuses an update that does not satisfy the installed app's designated requirement", () => {
  assert.throws(
    () =>
      planMacDesktopInstall({
        source: bundle(),
        current: bundle({ teamId: "OTHER12345" }),
        satisfiesCurrentRequirement: false,
        homeDirectory: "/Users/alice",
      }),
    /permission identity/,
  );
});

it("reports the one-time permission change when explicitly migrating from an ad-hoc install", () => {
  const plan = planMacDesktopInstall({
    source: bundle(),
    current: bundle({ developerId: false, teamId: null }),
    satisfiesCurrentRequirement: false,
    allowIdentityChange: true,
    homeDirectory: "/Users/alice",
  });
  assert.isTrue(plan.permissionIdentityChanges);
});

it("requires separate explicit overrides for a new ad-hoc signature", () => {
  const source = bundle({ developerId: false, teamId: null });
  const current = bundle({ developerId: false, teamId: null, version: "0.1.0" });
  assert.throws(
    () =>
      planMacDesktopInstall({
        source,
        current,
        satisfiesCurrentRequirement: false,
        homeDirectory: "/Users/alice",
        allowAdhoc: true,
      }),
    /permission identity/,
  );
});

it("allows an explicit Apple Development install without admitting an ad-hoc bundle", () => {
  const input = { homeDirectory: "/Users/alice", allowDevelopment: true };
  assert.isFalse(
    planMacDesktopInstall({
      ...input,
      source: bundle({ developerId: false, developmentSigned: true }),
    }).permissionIdentityChanges,
  );
  assert.throws(
    () => planMacDesktopInstall({ ...input, source: bundle({ developerId: false }) }),
    /Developer ID/,
  );
});
