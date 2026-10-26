import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  makeControlUrlConfig,
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ MINES_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("requires an explicit mines hosted origin instead of an upstream default", () =>
  Effect.gen(function* () {
    const absent = yield* hostedAppUrlConfig.pipe(provideEnv({}), Effect.result);
    assert.isTrue(Result.isFailure(absent));
    assert.equal(
      yield* hostedAppUrlConfig.pipe(provideEnv({ MINES_HOSTED_APP_URL: "https://mines.example" })),
      "https://mines.example",
    );
  }),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ MINES_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("uses the configured mines device service and honors runtime overrides", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* makeControlUrlConfig("https://embedded.example.test").pipe(provideEnv({})),
      "https://embedded.example.test",
    );
    assert.equal(
      yield* makeControlUrlConfig("https://embedded.example.test").pipe(
        provideEnv({ MINES_CONTROL_URL: "https://mines.example.test/" }),
      ),
      "https://mines.example.test",
    );
    const insecure = yield* makeControlUrlConfig("https://embedded.example.test").pipe(
      provideEnv({ MINES_CONTROL_URL: "http://mines.example.test" }),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(insecure));
  }),
);

it.effect("requires explicit CLI OAuth service endpoints", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      tokenEndpointFallback: "https://accounts.example.test/oauth/token",
      deviceAuthorizationEndpointFallback:
        "https://accounts.example.test/oauth/device_authorization",
      clientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://accounts.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://accounts.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

it.effect("does not infer CLI OAuth support from app account configuration", () =>
  Effect.gen(function* () {
    const result = yield* makeCloudCliOAuthConfig().pipe(
      provideEnv({ MINES_CONTROL_URL: "https://mines.example.test" }),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
  }),
);

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    MINES_TELEMETRY_ENABLED: "false",
    MINES_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        MINES_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        MINES_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        MINES_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
