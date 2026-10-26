import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import * as RpcHttp from "../rpc/http.ts";

const environmentId = EnvironmentId.make("environment-1");
function dependencies(calls: string[], version: number = ORCHESTRATION_PROTOCOL_VERSION) {
  return ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(async () => {
          calls.push("http");
          return Response.json({
            environmentId,
            label: "Host",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            orchestrationProtocolVersion: version,
            capabilities: { repositoryIdentity: true },
          });
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.die("Unexpected legacy credential read"),
          put: () => Effect.void,
          remove: () => Effect.void,
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
        Layer.succeed(ClientCapabilities.ClientPresentation, {
          metadata: { label: "Test", deviceType: "desktop", surface: "web" },
        }),
        Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
          authorizeBearer: () => Effect.die("Unexpected direct HTTP authorization"),
          authorizeDpop: () => Effect.die("Unexpected relay authorization"),
          authorizeDpopHttp: () => Effect.die("Unexpected relay authorization"),
        }),
      ),
    ),
  );
}
const primary = new PrimaryConnectionTarget({
  environmentId,
  label: "Primary",
  httpBaseUrl: "http://127.0.0.1:3777",
  wsBaseUrl: "ws://127.0.0.1:3777",
});

describe("ConnectionResolver direct-only policy", () => {
  it.effect("retains local primary connections and the protocol compatibility gate", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies(calls)),
      );
      const prepared = yield* resolver.prepare({
        target: primary,
        profile: Option.none(),
        enabled: true,
      });
      expect(prepared.socketUrl).toContain("orchestrationProtocol=2");
      expect(prepared.httpAuthorization).toBeNull();
      expect(calls).toEqual(["http"]);
      const old = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies([], 1)),
      );
      expect(
        yield* Effect.flip(old.prepare({ target: primary, profile: Option.none(), enabled: true })),
      ).toMatchObject({ reason: "unsupported" });
    }),
  );

  const legacy: ReadonlyArray<ConnectionCatalogEntry> = [
    {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Remote primary",
        httpBaseUrl: "https://remote.example",
        wsBaseUrl: "wss://remote.example",
      }),
      profile: Option.none(),
      enabled: true,
    },
    {
      target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
      profile: Option.none(),
      enabled: true,
    },
    {
      target: new SshConnectionTarget({ environmentId, label: "SSH", connectionId: "ssh-1" }),
      profile: Option.none(),
      enabled: true,
    },
    ...["plain", "t3-connect", "tailscale"].map((route): ConnectionCatalogEntry => ({
      target: new BearerConnectionTarget({ environmentId, label: route, connectionId: route }),
      profile: Option.some(
        new BearerConnectionProfile({
          environmentId,
          label: route,
          connectionId: route,
          httpBaseUrl: "https://legacy.example",
          wsBaseUrl: "wss://legacy.example",
          ...(route === "t3-connect" ? { authorization: "t3-connect" as const } : {}),
          ...(route === "tailscale" ? { network: "tailscale" as const } : {}),
        }),
      ),
      enabled: true,
    })),
  ];
  it.effect.each(legacy)(
    "blocks $target.label without authorizing, fetching, or opening a tunnel",
    (entry) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(dependencies(calls)),
        );
        expect(yield* Effect.flip(resolver.prepare(entry))).toMatchObject({
          reason: "unsupported",
        });
        expect(yield* Effect.flip(resolver.prepareForUpdate(entry))).toMatchObject({
          reason: "unsupported",
        });
        expect(calls).toEqual([]);
      }),
  );
});
