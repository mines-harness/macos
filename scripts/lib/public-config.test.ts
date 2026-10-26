// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "MINES_CONTROL_URL=https://root.example.test\nMINES_STUN_URL=stun:root.example.test:3478\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "MINES_CONTROL_URL=https://local.example.test\nMINES_STUN_URL=stun:local.example.test:3478\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).MINES_CONTROL_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          MINES_STUN_URL: "stun:ci.example.test:3478",
          MINES_CONTROL_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      MINES_CONTROL_URL: "https://ci.example.test",
      VITE_MINES_CONTROL_URL: "https://ci.example.test",
      EXPO_PUBLIC_MINES_CONTROL_URL: "https://ci.example.test",
      MINES_STUN_URL: "stun:ci.example.test:3478",
      VITE_MINES_STUN_URL: "stun:ci.example.test:3478",
      EXPO_PUBLIC_MINES_STUN_URL: "stun:ci.example.test:3478",
      MINES_RELAY_URL: undefined,
      VITE_MINES_RELAY_URL: undefined,
    });
  });
  it("never inherits an upstream identity, relay or telemetry destination", () => {
    const repoRoot = makeTemporaryDirectory();
    const resolved = loadRepoEnv({
      repoRoot,
      baseEnv: {
        MINES_CLERK_PUBLISHABLE_KEY: "upstream",
        VITE_CLERK_PUBLISHABLE_KEY: "upstream",
        T3CODE_CLERK_JWT_TEMPLATE: "upstream",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "upstream",
        T3CODE_RELAY_URL: "https://upstream.example",
        EXPO_PUBLIC_T3CODE_RELAY_URL: "https://upstream.example",
        VITE_RELAY_OTLP_TRACES_URL: "https://upstream.example/traces",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://upstream.example/traces",
      },
    });
    expect(resolved.MINES_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(resolved.MINES_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(resolved.MINES_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(resolved.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(resolved.MINES_RELAY_URL).toBeUndefined();
    expect(resolved.EXPO_PUBLIC_MINES_RELAY_URL).toBeUndefined();
    expect(resolved.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(resolved.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mines-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
