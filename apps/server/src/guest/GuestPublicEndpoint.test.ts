// @effect-diagnostics nodeBuiltinImport:off -- The fixture exercises signed HTTP requests and the real WebSocket handshake.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { PeerDeviceProof, type PeerConnectionState } from "@t3tools/contracts/minesPeer";
import { createPeerIdentity, verifyPeerDeviceProof } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { WebSocketServer, type WebSocket } from "ws";

import * as ServerConfig from "../config.ts";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GuestPublicEndpoint from "./GuestPublicEndpoint.ts";

const decodeProof = Schema.decodeUnknownSync(PeerDeviceProof);

function inbox<A>() {
  const values: A[] = [];
  const readers: Array<(value: A) => void> = [];
  return {
    push(value: A) {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    take: () =>
      new Promise<A>((resolve) => {
        const value = values.shift();
        if (value !== undefined) resolve(value);
        else readers.push(resolve);
      }),
  };
}

async function control(publicUrl = "https://guests.example.test") {
  const connections = inbox<WebSocket>();
  const proofs: PeerDeviceProof[] = [];
  const tickets = new Set<string>();
  const http = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/guest-config" && request.method === "GET") {
      response.end(JSON.stringify({ publicUrl }));
      return;
    }
    if (request.url === "/v1/device-tickets" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const proof = decodeProof(JSON.parse(body));
          proofs.push(verifyPeerDeviceProof(proof, "ticket", proof.issuedAt));
          const ticket = `00000000-0000-0000-0000-${String(proofs.length).padStart(12, "0")}`;
          tickets.add(ticket);
          response.end(JSON.stringify({ ticket }));
        } catch {
          response.writeHead(401).end("{}");
        }
      });
      return;
    }
    response.writeHead(404).end("{}");
  });
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const ticket = url.searchParams.get("ticket");
    if (url.pathname !== "/v1/guest-host" || !ticket || !tickets.delete(ticket)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => connections.push(connection));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing control address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    proofs,
    connections,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const identity = createPeerIdentity(new Uint8Array(32).fill(64), "Guest test host");

function mockControl() {
  const connections = inbox<Socket>();
  class Socket extends EventTarget {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readonly bufferedAmount = 0;
    readyState = 1;
    constructor() {
      super();
      connections.push(this);
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: '{"ready":true}' })),
      );
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/v1/guest-config")
              ? { publicUrl: "https://guests.example.test" }
              : { ticket: "00000000-0000-0000-0000-000000000001" },
          ),
        ),
    );
  return {
    connections,
    [Symbol.dispose]() {
      fetch.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

function testLayer(controlUrl: string, enabled = true, configured = true) {
  const signaling = Layer.effect(
    HostSignalingService.HostSignalingService,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<PeerConnectionState>({
        configured,
        online: configured,
        controlUrl,
        accountId: "test-account",
        stunServers: [],
        failure: null,
      });
      return HostSignalingService.HostSignalingService.of({
        state,
        configure: () => Effect.void,
        disable: Effect.void,
        start: Effect.void,
        connect: () => Effect.die("Unused peer connect"),
        authorizeSharedGroup: () => Effect.die("Unused shared group"),
        connectSharedGroup: () => Effect.die("Unused shared group"),
        subscribeSharedGroupSessions: () => () => {},
        subscribeSessions: () => () => {},
        disconnectDevice: () => Effect.void,
      });
    }),
  );
  const trust = Layer.succeed(PeerTrustStore.PeerTrustStore, {
    identity: Effect.succeed(identity),
    list: Effect.succeed([]),
    selectAccount: () => Effect.void,
    approve: () => Effect.void,
    beginApproval: () => Effect.succeed({ rollback: Effect.succeed(false) }),
    revoke: () => Effect.void,
  });
  const settings = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* SubscriptionRef.make(yield* base.getSettings);
      return {
        ...base,
        getSettings: SubscriptionRef.get(changes),
        updateSettings: (patch: Parameters<typeof base.updateSettings>[0]) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => SubscriptionRef.set(changes, next))),
        streamChanges: SubscriptionRef.changes(changes),
        subscribeChanges: Effect.succeed(SubscriptionRef.changes(changes)),
      };
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest({ guestSharingEnabled: enabled })));
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (value) => ({ ...value, port: 1 })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "guest-endpoint-" })));
  return GuestPublicEndpoint.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(signaling, trust, settings, config)),
    Layer.provide(NodeServices.layer),
  );
}

it.live(
  "connects eagerly with the existing device key and waits for ready before publishing a URL",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => control()),
        (value) => Effect.promise(value.close),
      );
      yield* Effect.gen(function* () {
        const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
        const socket = yield* Effect.promise(fixture.connections.take);
        expect(fixture.proofs).toHaveLength(1);
        expect(fixture.proofs[0]?.device).toEqual(identity.device);
        expect(yield* endpoint.current).toBeNull();
        const pending = yield* endpoint.ensure.pipe(Effect.forkScoped);
        socket.send(JSON.stringify({ ready: true }));
        const ready = yield* Fiber.join(pending);
        expect(ready.host).toBe(identity.device.deviceId);
        expect(ready.url("private-credential")).toBe(
          `https://guests.example.test/guest?host=${identity.device.deviceId}#private-credential`,
        );
        expect((yield* endpoint.current)?.host).toBe(identity.device.deviceId);
      }).pipe(Effect.provide(testLayer(fixture.url)));
    }).pipe(Effect.scoped),
);

it.live("closes on disable and reconnects on re-enable without a new share request", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => control()),
      (value) => Effect.promise(value.close),
    );
    yield* Effect.gen(function* () {
      const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* Effect.promise(fixture.connections.take);
      first.send(JSON.stringify({ ready: true }));
      const original = yield* endpoint.ensure;
      const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
      yield* settings.updateSettings({ guestSharingEnabled: false });
      yield* Effect.promise(() => closed);
      expect(yield* endpoint.current).toBeNull();
      yield* settings.updateSettings({ guestSharingEnabled: true });
      const second = yield* Effect.promise(fixture.connections.take);
      second.send(JSON.stringify({ ready: true }));
      expect((yield* endpoint.ensure).url("saved-credential")).toBe(
        original.url("saved-credential"),
      );
      expect(fixture.proofs).toHaveLength(2);
    }).pipe(Effect.provide(testLayer(fixture.url)));
  }).pipe(Effect.scoped),
);

it.live("reconnects when host configuration changes", () =>
  Effect.gen(function* () {
    const first = yield* Effect.acquireRelease(
      Effect.promise(() => control()),
      (value) => Effect.promise(value.close),
    );
    const second = yield* Effect.acquireRelease(
      Effect.promise(() => control("https://new-guests.example.test")),
      (value) => Effect.promise(value.close),
    );
    yield* Effect.gen(function* () {
      const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
      const signaling = yield* HostSignalingService.HostSignalingService;
      const socket = yield* Effect.promise(first.connections.take);
      socket.send(JSON.stringify({ ready: true }));
      yield* endpoint.ensure;
      yield* SubscriptionRef.update(signaling.state, (state) => ({
        ...state,
        controlUrl: second.url,
      }));
      const next = yield* Effect.promise(second.connections.take);
      next.send(JSON.stringify({ ready: true }));
      expect((yield* endpoint.ensure).url("credential")).toContain(
        "https://new-guests.example.test/guest?",
      );
    }).pipe(Effect.provide(testLayer(first.url)));
  }).pipe(Effect.scoped),
);

it.live("rejects a remote HTTP public URL before requesting a device ticket", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => control("http://public.example.test")),
      (value) => Effect.promise(value.close),
    );
    yield* Effect.gen(function* () {
      const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
      expect(yield* Effect.result(endpoint.ensure)).toMatchObject({
        _tag: "Failure",
        failure: { stage: "discovery" },
      });
      expect(yield* endpoint.current).toBeNull();
      expect(fixture.proofs).toHaveLength(0);
    }).pipe(Effect.provide(testLayer(fixture.url)));
  }).pipe(Effect.scoped),
);

it.live("does not publish an endpoint while disabled or unconfigured", () =>
  Effect.gen(function* () {
    for (const [enabled, configured, stage] of [
      [false, true, "disabled"],
      [true, false, "unconfigured"],
    ] as const) {
      yield* Effect.gen(function* () {
        const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
        expect(yield* endpoint.current).toBeNull();
        expect(yield* Effect.result(endpoint.ensure)).toMatchObject({
          _tag: "Failure",
          failure: { stage },
        });
      }).pipe(Effect.provide(testLayer("http://127.0.0.1:1", enabled, configured)));
    }
  }).pipe(Effect.scoped),
);

it.effect("reconnects a lost public channel automatically on the retry schedule", () =>
  Effect.gen(function* () {
    using fixture = mockControl();
    yield* Effect.gen(function* () {
      const endpoint = yield* GuestPublicEndpoint.GuestPublicEndpoint;
      const first = yield* Effect.promise(fixture.connections.take);
      const original = yield* endpoint.ensure;
      first.close();
      expect(yield* endpoint.current).toBeNull();
      yield* TestClock.adjust("5 seconds");
      const second = yield* Effect.promise(fixture.connections.take);
      expect(second).not.toBe(first);
      expect((yield* endpoint.ensure).url("persisted-credential")).toBe(
        original.url("persisted-credential"),
      );
    }).pipe(Effect.provide(testLayer("https://control.example.test")));
  }).pipe(Effect.scoped),
);
