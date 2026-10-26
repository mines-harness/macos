import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as DesktopConfig from "./DesktopConfig.ts";

const readConfig = (env: Readonly<Record<string, string>>) =>
  DesktopConfig.DesktopConfig.pipe(Effect.provide(DesktopConfig.layerTest(env)));

describe("DesktopConfig", () => {
  it.effect("reads mines launch settings and explicit disabled values", () =>
    Effect.gen(function* () {
      const config = yield* readConfig({
        MINES_HOME: "/isolated/mines",
        MINES_PORT: "4242",
        MINES_COMMIT_HASH: "abcdef1234567890",
        MINES_DESKTOP_LAN_HOST: "192.0.2.10",
        MINES_DESKTOP_HTTPS_ENDPOINTS: "https://first.example, https://second.example",
        MINES_DISABLE_AUTO_UPDATE: "true",
        MINES_DESKTOP_MOCK_UPDATES: "false",
        MINES_OTLP_TRACES_URL: "",
        MINES_OTLP_EXPORT_INTERVAL_MS: "12000",
        MINES_OTLP_PROTOCOL: "http/protobuf",
      });

      assert.equal(Option.getOrThrow(config.minesHome), "/isolated/mines");
      assert.equal(Option.getOrThrow(config.configuredBackendPort), 4242);
      assert.equal(Option.getOrThrow(config.commitHashOverride), "abcdef1234567890");
      assert.equal(Option.getOrThrow(config.desktopLanHostOverride), "192.0.2.10");
      assert.deepEqual(config.desktopHttpsEndpointUrls, [
        "https://first.example",
        "https://second.example",
      ]);
      assert.isTrue(config.disableAutoUpdate);
      assert.isFalse(config.mockUpdates);
      assert.isTrue(Option.isNone(config.otlpTracesUrl));
      assert.equal(config.otlpExportIntervalMs, 12000);
      assert.equal(config.otlpProtocol, "http/protobuf");
    }),
  );

  it.effect("rejects an invalid mines backend port", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(readConfig({ MINES_PORT: "invalid" }));
      assert.isTrue(Exit.isFailure(result));
    }),
  );
});
