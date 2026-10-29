// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- Fixtures exercise the native HTTP/WebSocket transport boundary.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WebSocketServer } from "ws";

import {
  makeGuestProxy,
  parseGuestProxyConfig,
} from "../../../../infra/mines-control/src/GuestProxy.ts";
import { bindGuestProxyBridge } from "./GuestProxyBridge.ts";
import { verifiedGuestProxyIp } from "./guestProxyTrust.ts";

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return address.port;
}

async function stop(server: NodeHttp.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it.live(
  "streams public guest HTTP, cookies and binary files through the reverse channel and cancels upstream",
  () =>
    Effect.promise(async () => {
      const deviceId = "guest_host_0123456789";
      const proxy = makeGuestProxy(parseGuestProxyConfig("https://mines.gemstud.io"));
      const binary = Buffer.from(
        Array.from({ length: 128 * 1024 + 17 }, (_, index) => index % 251),
      );
      const streamClosed = Promise.withResolvers<void>();
      const hosted = Promise.withResolvers<void>();
      const observed: Array<{
        method: string;
        path: string;
        ip: string | null;
        headers: NodeHttp.IncomingHttpHeaders;
        body: Buffer;
      }> = [];
      let liveResponse: NodeHttp.ServerResponse | undefined;
      let upstreamClosed = false;
      const local = NodeHttp.createServer((request, response) => {
        void (async () => {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers))
            if (typeof value === "string") headers[name] = value;
          const ip = verifiedGuestProxyIp(headers, request.socket.remoteAddress);
          observed.push({
            method: request.method ?? "",
            path: request.url ?? "",
            ip,
            headers: request.headers,
            body: Buffer.concat(chunks),
          });
          if (ip === null) {
            response.writeHead(403);
            response.end();
            return;
          }
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          if (path === "/api/guest/redeem") {
            response.writeHead(204, {
              "set-cookie":
                "mines_guest_share_001=session; Path=/api/guest; Max-Age=900; HttpOnly; Secure; SameSite=Strict",
            });
            response.end();
          } else if (request.headers.cookie !== "mines_guest_share_001=session") {
            response.writeHead(403);
            response.end();
          } else if (path === "/api/guest/stream") {
            liveResponse = response;
            response.once("close", () => {
              upstreamClosed = true;
              streamClosed.resolve();
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: first\n\n");
          } else if (path === "/api/guest/attachment") {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            response.end(binary);
          } else if (path === "/api/guest/messages" || path === "/api/guest/activity") {
            response.writeHead(204);
            response.end();
          } else {
            response.writeHead(404);
            response.end();
          }
        })().catch(() => {
          response.writeHead(500);
          response.end();
        });
      });
      const localPort = await listen(local);
      const control = NodeHttp.createServer((request, response) => {
        void proxy
          .handle(request, response)
          .then((handled) => {
            if (!handled) {
              response.writeHead(404);
              response.end();
            }
          })
          .catch(() => {
            response.writeHead(500);
            response.end();
          });
      });
      const sockets = new WebSocketServer({
        server: control,
        path: "/v1/guest-host",
        maxPayload: 96 * 1024,
      });
      sockets.on("connection", (socket) => {
        const host = proxy.connect(deviceId, {
          send: (frame) => socket.send(JSON.stringify(frame)),
          close: () => socket.close(),
        });
        socket.on("message", (data) => host.receive(JSON.parse(data.toString())));
        socket.once("close", host.disconnect);
        hosted.resolve();
      });
      const controlPort = await listen(control);
      const channel = new WebSocket(`ws://127.0.0.1:${controlPort}/v1/guest-host`);
      const abort = new AbortController();
      let unbind = () => {};
      try {
        await new Promise<void>((resolve) =>
          channel.addEventListener("open", () => resolve(), { once: true }),
        );
        unbind = bindGuestProxyBridge(channel, localPort);
        await hosted.promise;
        const base = `http://127.0.0.1:${controlPort}/api/guest/hosts/${deviceId}`;
        const redeem = await fetch(`${base}/redeem`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "account=private",
            authorization: "Bearer owner",
            "x-forwarded-for": "198.51.100.99",
            "x-real-ip": "198.51.100.99",
            "x-mines-guest-proxy-ip": "198.51.100.99",
          },
          body: JSON.stringify({ name: "Camille", credential: "share_001.signature" }),
        });
        expect(redeem.status).toBe(204);
        expect(redeem.headers.getSetCookie()).toEqual([
          `mines_guest_share_001=session; Path=/api/guest/hosts/${deviceId}; Max-Age=900; HttpOnly; Secure; SameSite=Strict`,
        ]);
        expect(observed[0]).toMatchObject({ path: "/api/guest/redeem", ip: "127.0.0.1" });
        expect(observed[0]?.headers.authorization).toBeUndefined();
        expect(observed[0]?.headers.cookie).toBeUndefined();
        expect(JSON.parse(observed[0]!.body.toString())).toMatchObject({ name: "Camille" });

        const cookie = "mines_guest_share_001=session";
        const stream = await fetch(`${base}/stream?share=share_001`, {
          headers: { cookie },
          signal: abort.signal,
        });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
        expect(upstreamClosed).toBe(false);
        liveResponse!.write("data: second\n\n");
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");

        const attachment = await fetch(`${base}/attachment?share=share_001&id=file`, {
          headers: { cookie },
        });
        expect(attachment.status).toBe(200);
        expect(Buffer.from(await attachment.arrayBuffer())).toEqual(binary);
        const body = new FormData();
        body.set("shareId", "share_001");
        body.set("file", new Blob([binary]), "bytes.bin");
        const upload = await fetch(`${base}/messages?share=share_001`, {
          method: "POST",
          headers: { cookie },
          body,
        });
        expect(upload.status).toBe(204);
        const uploaded = observed.find((request) => request.path.startsWith("/api/guest/messages"));
        expect(uploaded?.body.includes(binary)).toBe(true);
        expect(uploaded?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
        const activity = await fetch(`${base}/activity?share=share_001`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ shareId: "share_001", kind: "voice" }),
        });
        expect(activity.status).toBe(204);
        const activityRequest = observed.find((request) =>
          request.path.startsWith("/api/guest/activity"),
        );
        expect(JSON.parse(activityRequest!.body.toString())).toEqual({
          shareId: "share_001",
          kind: "voice",
        });
        for (const method of ["PATCH", "DELETE"]) {
          const payload = {
            shareId: "share_001",
            guestMessageId: "message",
            text: "Revised",
            expectedRevision: 0,
            requestId: method,
          };
          const mutation = await fetch(`${base}/messages?share=share_001`, {
            method,
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          expect(mutation.status).toBe(204);
          const forwarded = observed.find((request) => request.method === method);
          expect(forwarded?.path).toBe("/api/guest/messages?share=share_001");
          expect(JSON.parse(forwarded!.body.toString())).toEqual(payload);
          const foreign = await fetch(`${base}/messages?share=share_001`, {
            method,
            headers: {
              cookie: "mines_guest_share_001=foreign",
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          expect(foreign.status).toBe(403);
        }
        expect((await fetch(`${base}/devices`)).status).toBe(404);
        expect(observed.some((request) => request.path.includes("devices"))).toBe(false);

        await reader.cancel();
        reader.releaseLock();
        await streamClosed.promise;
        expect(upstreamClosed).toBe(true);
      } finally {
        abort.abort();
        unbind();
        channel.close();
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        await stop(control);
        await stop(local);
      }
    }),
);
