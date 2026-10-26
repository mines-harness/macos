import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { PeerError } from "@t3tools/contracts/minesPeer";
import { PeerConnections, type PeerSession } from "@t3tools/client-runtime/peer";
import {
  EnvironmentRegistry,
  type BearerConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { encodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  loadBrowserPeerIdentity,
  pairBrowserPeer,
  restoreBrowserPeers,
  forgetBrowserPeer,
} from "./peerPairing";

const mock = vi.hoisted(() => ({
  stores: new Map<string, Map<string, Uint8Array>>(),
  register: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
  gatewayClose: vi.fn(),
}));
vi.mock("../catalog/storage", () => ({
  openBrowserPrivateStore: async (accountId: string) => {
    let store = mock.stores.get(accountId);
    if (!store) {
      store = new Map();
      mock.stores.set(accountId, store);
    }
    return {
      read: async (key: string) => store!.get(key) ?? null,
      write: async (key: string, value: Uint8Array) => {
        store!.set(key, value);
      },
    };
  },
}));
vi.mock("@t3tools/client-runtime/peer", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/peer")>()),
  registerPeerDevice: mock.register,
  connectDirectPeer: mock.connect,
  openPeerSignalGateway: async () => ({ close: mock.gatewayClose }),
  peerFetch: () => mock.fetch,
}));
afterEach(() => vi.unstubAllGlobals());
const host = createPeerIdentity(new Uint8Array(32).fill(9), "Other computer").device;
const environmentId = EnvironmentId.make("peer-computer");
const pairingUrl = encodePeerPairing({
  version: 1,
  host,
  controlUrl: "https://account.example.com",
  stunServers: [],
  environmentId,
  pairingToken: "bootstrap-secret",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
function fixture() {
  mock.stores.clear();
  vi.clearAllMocks();
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {
    locks: { request: async (_key: string, operation: () => Promise<unknown>) => operation() },
  });
  mock.register.mockResolvedValue("account-a");
  mock.connect.mockResolvedValue({ remoteDeviceId: host.deviceId, close: mock.close });
  mock.fetch.mockImplementation(async (input: string) => {
    if (String(input).endsWith("/.well-known/t3/environment"))
      return Response.json({
        environmentId,
        label: "Other computer",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      });
    if (String(input).endsWith("/oauth/token"))
      return Response.json({
        access_token: "scoped-bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "threads:read",
      });
    throw new Error("Unexpected resource");
  });
  const routes = new Map<string, Effect.Effect<PeerSession, PeerError>>();
  const registrations: BearerConnectionRegistration[] = [];
  const removed: string[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(PeerConnections, {
      clear: Effect.sync(() => routes.clear()),
      register: (id, connect) =>
        Effect.sync(() => {
          routes.set(id, connect);
          return () => {
            routes.delete(id);
          };
        }),
      connect: () => Effect.fail(new PeerError({ code: "direct-unavailable" })),
      subscribeSessions: () => () => {},
    }),
    Layer.succeed(ClientCapabilities.ClientPresentation, {
      metadata: { label: "This computer", deviceType: "desktop", os: "macOS" },
    }),
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const entries = yield* SubscriptionRef.make(new Map());
        return {
          entries,
          register: (value: BearerConnectionRegistration) =>
            Effect.sync(() => {
              registrations.push(value);
              return true;
            }),
          setEnabled: () => Effect.void,
          retryNow: () => Effect.void,
          remove: (id: string) =>
            Effect.sync(() => {
              removed.push(id);
            }),
        } as unknown as Effect.Success<typeof EnvironmentRegistry.EnvironmentRegistry>;
      }),
    ),
  );
  return { routes, registrations, removed, layer };
}
describe("browser and desktop direct pairing", () => {
  it.effect("keeps device keys stable and separated by system account", () => {
    fixture();
    return Effect.gen(function* () {
      const first = yield* loadBrowserPeerIdentity("account-a");
      const second = yield* loadBrowserPeerIdentity("account-b");
      expect((yield* loadBrowserPeerIdentity("account-a")).device).toEqual(first.device);
      expect(second.device.deviceId).not.toBe(first.device.deviceId);
    });
  });
  it.effect(
    "pairs through the pinned peer, restores only the account's routes, and forgets it",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* pairBrowserPeer({
          accountId: "account-a",
          pairingUrl,
          getToken: async () => "clerk-token",
        });
        expect(mock.connect.mock.calls[0]?.[0].approved).toEqual(host);
        expect(mock.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
          "http://127.0.0.1/.well-known/t3/environment",
          "http://127.0.0.1/oauth/token",
        ]);
        expect(f.registrations[0]?.profile.peerDeviceId).toBe(host.deviceId);
        expect(f.registrations[0]?.credential.token).toBe("scoped-bearer");
        const stored = new TextDecoder().decode(
          mock.stores.get("account-a")?.get("peer.routes.v1"),
        );
        expect(stored).not.toContain("bootstrap-secret");
        expect(stored).not.toContain("clerk-token");
        expect(stored).not.toContain("scoped-bearer");
        expect(yield* restoreBrowserPeers("account-b")).toEqual([]);
        expect(f.routes.size).toBe(0);
        expect(yield* restoreBrowserPeers("account-a")).toEqual([environmentId]);
        expect(yield* forgetBrowserPeer({ accountId: "account-a", environmentId })).toEqual([]);
        expect(f.routes.size).toBe(0);
        expect(f.removed).toEqual([environmentId]);
        expect(mock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect("rejects mismatched account registration before using the pairing code", () => {
    const f = fixture();
    mock.register.mockResolvedValueOnce("account-b");
    return Effect.gen(function* () {
      const outcome = yield* pairBrowserPeer({
        accountId: "account-a",
        pairingUrl,
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(mock.connect).not.toHaveBeenCalled();
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("never redeems or persists a route when direct negotiation fails", () => {
    const f = fixture();
    mock.connect.mockRejectedValueOnce(new PeerError({ code: "direct-unavailable" }));
    return Effect.gen(function* () {
      const outcome = yield* pairBrowserPeer({
        accountId: "account-a",
        pairingUrl,
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
      expect(mock.stores.get("account-a")?.has("peer.routes.v1")).toBe(false);
    }).pipe(Effect.provide(f.layer));
  });
});
