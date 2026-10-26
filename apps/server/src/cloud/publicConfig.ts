import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  hostedAppOrigin,
} from "@t3tools/shared/connectAuth";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __MINES_BUILD_RELAY_URL__: string | undefined;
declare const __MINES_BUILD_CONTROL_URL__: string | undefined;
declare const __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __MINES_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__MINES_BUILD_RELAY_URL__) ?? "");
const buildTimeControlUrl = readBuildTimeValue(
  typeof __MINES_BUILD_CONTROL_URL__ === "undefined" ? undefined : __MINES_BUILD_CONTROL_URL__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __MINES_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  if (!isRelayTracingEnabled(env)) {
    return null;
  }

  const tracesUrl = env.MINES_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.MINES_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.MINES_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("MINES_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hostedAppUrlConfig = makePublicValueConfig("MINES_HOSTED_APP_URL", "").pipe(
  Config.mapEffect(validateHostedAppUrl),
);

function validateHostedAppUrl(value: string) {
  try {
    const origin = hostedAppOrigin(value);
    if (!origin) throw new Error("invalid hosted app origin");
    return Effect.succeed(origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export function makeControlUrlConfig(fallback = buildTimeControlUrl) {
  return makePublicValueConfig("MINES_CONTROL_URL", fallback).pipe(
    Config.mapEffect((value) => {
      const origin = hostedAppOrigin(value);
      return origin
        ? Effect.succeed(origin)
        : Effect.fail(
            new Config.ConfigError(
              new Schema.SchemaError(
                new SchemaIssue.InvalidValue({
                  message:
                    "Device control URL must be an absolute HTTPS origin (or HTTP loopback origin).",
                }),
              ),
            ),
          );
    }),
  );
}

export const controlUrlConfig = makeControlUrlConfig();

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  tokenEndpointFallback = "",
  deviceAuthorizationEndpointFallback = "",
  clientIdFallback = "",
}: {
  readonly tokenEndpointFallback?: string;
  readonly deviceAuthorizationEndpointFallback?: string;
  readonly clientIdFallback?: string;
} = {}) {
  return Config.all({
    tokenEndpoint: makePublicValueConfig("MINES_CLI_OAUTH_TOKEN_URL", tokenEndpointFallback),
    deviceAuthorizationEndpoint: makePublicValueConfig(
      "MINES_CLI_OAUTH_DEVICE_AUTHORIZATION_URL",
      deviceAuthorizationEndpointFallback,
    ),
    clientId: makePublicValueConfig("MINES_CLI_OAUTH_CLIENT_ID", clientIdFallback),
  }).pipe(
    Config.mapEffect(({ tokenEndpoint, deviceAuthorizationEndpoint, clientId }) =>
      Effect.try({
        try: () => {
          for (const value of [tokenEndpoint, deviceAuthorizationEndpoint]) {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password || url.hash)
              throw new Error("Invalid OAuth endpoint.");
          }
          return {
            tokenEndpoint,
            deviceAuthorizationEndpoint,
            clientId,
            loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
            redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
            scopes: CLOUD_CLI_OAUTH_SCOPES,
          } satisfies CloudCliOAuthConfig;
        },
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "CLI OAuth endpoints must be explicit HTTPS URLs for your own service.",
              cause,
            }),
          ),
      }),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeSecureRelayUrl(process.env.MINES_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
  process.env.MINES_CLI_OAUTH_TOKEN_URL?.trim() &&
  process.env.MINES_CLI_OAUTH_DEVICE_AUTHORIZATION_URL?.trim() &&
  process.env.MINES_CLI_OAUTH_CLIENT_ID?.trim(),
);
