// @effect-diagnostics nodeBuiltinImport:off -- these fixtures exercise the actual loopback HTTP and WebSocket boundary.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import type { PeerChannel, PeerResourceResponse } from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Effect from "effect/Effect";
import { WebSocketServer } from "ws";
import { bindPeerLoopback, peerLoopbackUrl } from "./PeerLoopbackBridge.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function peer(initialRpc?: Uint8Array) {
  const listeners = new Map<PeerChannel, (data: Uint8Array) => void>();
  let close!: () => void;
  let resolveResponse!: (value: PeerResourceResponse) => void;
  let resolveRpc!: (value: string) => void;
  const response = new Promise<PeerResourceResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const rpc = new Promise<string>((resolve) => {
    resolveRpc = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const session: PeerSession = {
    remoteDeviceId: "approved_test_peer",
    closed,
    close,
    send: async (channel, bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (channel === "resource") resolveResponse(JSON.parse(text));
      if (channel === "rpc") resolveRpc(text);
    },
    subscribe(channel, listener) {
      listeners.set(channel, listener);
      if (channel === "rpc" && initialRpc) listener(initialRpc);
      return () => {
        listeners.delete(channel);
      };
    },
  };
  return {
    session,
    response,
    rpc,
    listeners,
    receive: (channel: PeerChannel, value: unknown) => listeners.get(channel)?.(encode(value)),
  };
}

async function server(handler: NodeHttp.RequestListener) {
  const http = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    http,
    port: address.port,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const request = (headers: Record<string, string> = {}, path = "/api/test") => ({
  id: "resource_request_001",
  method: "GET",
  path,
  headers,
  encoding: "base64",
});

it.each([
  "https://elsewhere.test/api/a",
  "//elsewhere.test/api/a",
  "/\\elsewhere.test/api/a",
  "/api/a\r\nHost: elsewhere",
  "/api/a#fragment",
  "/api/../../private",
  "/private",
])("rejects the nonlocal resource path %s", (path) => {
  expect(() => peerLoopbackUrl(1234, path)).toThrow();
});

it.each([
  "/ws",
  "/api/a?wsTicket=ticket",
  "/ws?wsTicket=",
  "/ws?wsTicket=a&wsTicket=b",
  "/ws?wsTicket=a&dpop=proof",
])("requires a single scoped RPC ticket in %s", (path) => {
  expect(() => peerLoopbackUrl(1234, path, true)).toThrow();
});

it("handles an invalid RPC message delivered synchronously by subscribe", async () => {
  const fixture = peer(encode({ invalid: true }));
  const cleanup = bindPeerLoopback(fixture.session, 1234);
  await fixture.session.closed;
  expect(fixture.listeners.size).toBe(0);
  cleanup();
});

it.live("forwards only the caller bearer and approved resource headers", () =>
  Effect.promise(async () => {
    let observed: NodeHttp.IncomingHttpHeaders | undefined;
    const fixture = await server((incoming, response) => {
      observed = incoming.headers;
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "host-secret=never",
        "x-private": "never",
      });
      response.end('{"ok":true}');
    });
    const client = peer();
    const cleanup = bindPeerLoopback(client.session, fixture.port);
    try {
      client.receive(
        "resource",
        request({
          authorization: "Bearer caller-scoped-token",
          cookie: "host-admin=secret",
          host: "elsewhere.test",
          "proxy-authorization": "Basic secret",
          "x-forwarded-host": "elsewhere.test",
          dpop: "never",
          [ORCHESTRATION_PROTOCOL_HEADER]: "2",
          range: "bytes=0-100",
        }),
      );
      const response = await client.response;
      expect(response.status).toBe(200);
      expect(Buffer.from(response.body, "base64").toString()).toBe('{"ok":true}');
      expect(observed).toMatchObject({
        authorization: "Bearer caller-scoped-token",
        host: `127.0.0.1:${fixture.port}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: "2",
        range: "bytes=0-100",
      });
      expect(observed?.cookie).toBeUndefined();
      expect(observed?.["proxy-authorization"]).toBeUndefined();
      expect(observed?.["x-forwarded-host"]).toBeUndefined();
      expect(observed?.dpop).toBeUndefined();
      expect(response.headers).toEqual({ "content-type": "application/json" });
    } finally {
      cleanup();
      await fixture.close();
    }
  }),
);

it.live("does not inject host credentials or forward DPoP authorization", () =>
  Effect.promise(async () => {
    let authorization: string | undefined;
    const fixture = await server((incoming, response) => {
      authorization = incoming.headers.authorization;
      response.writeHead(401);
      response.end();
    });
    const client = peer();
    const cleanup = bindPeerLoopback(client.session, fixture.port);
    try {
      client.receive("resource", request({ authorization: "DPoP forged", dpop: "forged" }));
      expect((await client.response).status).toBe(401);
      expect(authorization).toBeUndefined();
    } finally {
      cleanup();
      await fixture.close();
    }
  }),
);

it.live("refuses HTTP redirects and decoded response bodies above the bound", () =>
  Effect.promise(async () => {
    let redirected = false;
    const fixture = await server((incoming, response) => {
      if (incoming.url === "/api/redirect") {
        response.writeHead(302, { location: "/api/private" });
        response.end();
      } else if (incoming.url === "/api/large") {
        response.writeHead(200);
        response.end(Buffer.alloc(12 * 1024 * 1024 + 1));
      } else {
        redirected = true;
        response.end();
      }
    });
    try {
      for (const path of ["/api/redirect", "/api/large"]) {
        const client = peer();
        const cleanup = bindPeerLoopback(client.session, fixture.port);
        try {
          client.receive("resource", request({}, path));
          expect((await client.response).status).toBe(502);
        } finally {
          cleanup();
        }
      }
      expect(redirected).toBe(false);
    } finally {
      await fixture.close();
    }
  }),
);

it.live("cancels an active resource stream when the peer is revoked", () =>
  Effect.promise(async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const fixture = await server((_incoming, response) => {
      response.on("close", cancelled);
      response.writeHead(200);
      response.write("partial");
      started();
    });
    const client = peer();
    const cleanup = bindPeerLoopback(client.session, fixture.port);
    try {
      client.receive("resource", request());
      await ready;
      client.session.close();
      await stopped;
      expect(client.listeners.size).toBe(0);
    } finally {
      cleanup();
      await fixture.close();
    }
  }),
);

it.live("uses the connecting device's websocket ticket and preserves queued RPC frames", () =>
  Effect.promise(async () => {
    const fixture = await server((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    let path: string | undefined;
    let authorization: string | undefined;
    fixture.http.on("upgrade", (incoming, socket, head) => {
      path = incoming.url;
      authorization = incoming.headers.authorization;
      sockets.handleUpgrade(incoming, socket, head, (connection) =>
        connection.on("message", (data) => connection.send(data.toString())),
      );
    });
    const client = peer(
      encode({
        type: "mines.rpc.open",
        path: "/ws?wsTicket=caller-ticket&orchestrationProtocol=2",
      }),
    );
    const cleanup = bindPeerLoopback(client.session, fixture.port);
    try {
      client.receive("rpc", { _tag: "Ping" });
      expect(await client.rpc).toBe('{"_tag":"Ping"}');
      expect(path).toBe("/ws?wsTicket=caller-ticket&orchestrationProtocol=2");
      expect(authorization).toBeUndefined();
    } finally {
      cleanup();
      for (const connection of sockets.clients) connection.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await fixture.close();
    }
  }),
);
