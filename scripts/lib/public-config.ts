// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface MinesPublicConfig {
  readonly controlUrl: string | undefined;
  readonly stunUrl: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    // No upstream configuration is inherited.
    MINES_CONTROL_URL: config.controlUrl,
    VITE_MINES_CONTROL_URL: config.controlUrl,
    EXPO_PUBLIC_MINES_CONTROL_URL: config.controlUrl,
    MINES_STUN_URL: config.stunUrl,
    VITE_MINES_STUN_URL: config.stunUrl,
    EXPO_PUBLIC_MINES_STUN_URL: config.stunUrl,
    MINES_CLERK_PUBLISHABLE_KEY: undefined,
    VITE_CLERK_PUBLISHABLE_KEY: undefined,
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined,
    MINES_CLERK_JWT_TEMPLATE: undefined,
    VITE_CLERK_JWT_TEMPLATE: undefined,
    EXPO_PUBLIC_CLERK_JWT_TEMPLATE: undefined,
    MINES_CLERK_CLI_OAUTH_CLIENT_ID: undefined,
    VITE_CLERK_CLI_OAUTH_CLIENT_ID: undefined,
    MINES_RELAY_URL: undefined,
    VITE_MINES_RELAY_URL: undefined,
    EXPO_PUBLIC_MINES_RELAY_URL: undefined,
    MINES_RELAY_CLIENT_OTLP_TRACES_URL: undefined,
    VITE_RELAY_OTLP_TRACES_URL: undefined,
    MINES_RELAY_CLIENT_OTLP_TRACES_DATASET: undefined,
    VITE_RELAY_OTLP_TRACES_DATASET: undefined,
    MINES_RELAY_CLIENT_OTLP_TRACES_TOKEN: undefined,
    VITE_RELAY_OTLP_TRACES_TOKEN: undefined,
    MINES_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
    EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
    MINES_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
    EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
    MINES_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
    EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): MinesPublicConfig {
  return {
    controlUrl: firstNonEmpty(sources, "MINES_CONTROL_URL"),
    stunUrl: firstNonEmpty(sources, "MINES_STUN_URL"),
    // Device traffic never uses the upstream relay or telemetry endpoints.
    relayUrl: undefined,
    mobileOtlpTracesUrl: firstNonEmpty(sources, "MINES_MOBILE_OTLP_TRACES_URL"),
    mobileOtlpTracesDataset: firstNonEmpty(sources, "MINES_MOBILE_OTLP_TRACES_DATASET"),
    mobileOtlpTracesToken: firstNonEmpty(sources, "MINES_MOBILE_OTLP_TRACES_TOKEN"),
    relayClientOtlpTracesUrl: undefined,
    relayClientOtlpTracesDataset: undefined,
    relayClientOtlpTracesToken: undefined,
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
