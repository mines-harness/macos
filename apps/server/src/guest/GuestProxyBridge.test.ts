// @effect-diagnostics nodeBuiltinImport:off -- These fixtures own disposable loopback HTTP and WebSocket servers.
import * as NodeHttp from "node:http";
import { expect, it, vi } from "@effect/vitest";
import {
  GUEST_PROXY_CHUNK_BYTES,
  GUEST_PROXY_MAX_REQUEST_BYTES,
  GuestProxyHostFrame,
  type GuestProxyRequest,
} from "@t3tools/shared/guestProxy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import { bindGuestProxyBridge } from "./GuestProxyBridge.ts";
import { verifiedGuestProxyIp } from "./guestProxyTrust.ts";

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

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(GuestProxyHostFrame));
const request = (id: string, overrides: Partial<GuestProxyRequest> = {}): GuestProxyRequest => ({
  type: "request",
  id,
  method: "GET",
  path: "/api/guest/session",
  headers: {},
  ipAddress: "198.51.100.25",
  ...overrides,
});

async function fixture(handler: NodeHttp.RequestListener) {
  const http = NodeHttp.createServer(handler);
  const sockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (incoming, socket, head) => {
    sockets.handleUpgrade(incoming, socket, head, (connection) => {
      sockets.emit("connection", connection, incoming);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const connected = new Promise<ServerWebSocket>((resolve) => sockets.once("connection", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/host`);
  const opened = new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve(), { once: true }),
  );
  const [control] = await Promise.all([connected, opened]);
  const frames = inbox<GuestProxyHostFrame>();
  const observed: GuestProxyHostFrame[] = [];
  control.on("message", (data) => {
    const frame = decodeFrame(data.toString());
    observed.push(frame);
    frames.push(frame);
  });
  const disconnected = new Promise<void>((resolve) => control.once("close", () => resolve()));
  const unbind = bindGuestProxyBridge(socket, address.port);
  const send = (value: unknown) => control.send(JSON.stringify(value));
  return {
    port: address.port,
    socket,
    frames,
    observed,
    disconnected,
    send,
    unbind,
    ack: (id: string) => send({ type: "ack", id }),
    async [Symbol.asyncDispose]() {
      unbind();
      socket.close();
      for (const connection of sockets.clients) connection.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function response(client: Awaited<ReturnType<typeof fixture>>, id: string) {
  const head = await client.frames.take();
  expect(head).toMatchObject({ type: "head", id });
  const chunks: Buffer[] = [];
  for (;;) {
    const frame = await client.frames.take();
    expect(frame.id).toBe(id);
    if (frame.type === "end") break;
    if (frame.type !== "chunk") throw new Error("Unexpected response frame");
    const chunk = Buffer.from(frame.body, "base64");
    expect(chunk.length).toBeLessThanOrEqual(GUEST_PROXY_CHUNK_BYTES);
    chunks.push(chunk);
    client.ack(id);
  }
  return { head, body: Buffer.concat(chunks) };
}

it.live("forwards guest headers and binary bodies with authenticated IP and separate cookies", () =>
  Effect.promise(async () => {
    const incomingRequest = Promise.withResolvers<{
      headers: NodeHttp.IncomingHttpHeaders;
      body: Buffer;
      ip: string | null;
    }>();
    await using client = await fixture((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const headers = Object.fromEntries(
          Object.entries(incoming.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        incomingRequest.resolve({
          headers: incoming.headers,
          body: Buffer.concat(chunks),
          ip: verifiedGuestProxyIp(headers, incoming.socket.remoteAddress),
        });
        outgoing.writeHead(201, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "content-disposition": "attachment; filename=guest.bin",
          "set-cookie": [
            "mines_guest_one=a; Path=/api/guest; HttpOnly",
            "mines_guest_two=b; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/api/guest",
          ],
          connection: "close, etag",
          etag: "must-not-forward",
          "x-private": "must-not-forward",
        });
        outgoing.end(Buffer.from([0, 255, 128, 1]));
      });
    });
    const body = Buffer.from([0, 255, 128, 1]);
    client.send(
      request("guest_request_binary", {
        method: "POST",
        path: "/api/guest/messages?share=fixture",
        body: body.toString("base64"),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          cookie: "mines_guest_one=caller",
          range: "bytes=0-3",
          "if-none-match": "guest-etag",
          "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
          "last-event-id": "event-17",
          authorization: "Bearer owner",
          host: "elsewhere.test",
          origin: "https://elsewhere.test",
          "proxy-authorization": "Basic owner",
          "x-forwarded-for": "10.0.0.1",
          "x-mines-guest-proxy-token": "forged",
          "x-mines-guest-proxy-ip": "10.0.0.2",
        },
      }),
    );
    const result = await response(client, "guest_request_binary");
    const observed = await incomingRequest.promise;
    expect(observed.body).toEqual(body);
    expect(observed.ip).toBe("198.51.100.25");
    expect(observed.headers).toMatchObject({
      host: `127.0.0.1:${client.port}`,
      accept: "application/json",
      cookie: "mines_guest_one=caller",
      range: "bytes=0-3",
      "if-none-match": "guest-etag",
      "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
      "last-event-id": "event-17",
    });
    for (const name of ["authorization", "origin", "proxy-authorization", "x-forwarded-for"])
      expect(observed.headers[name]).toBeUndefined();
    expect(result.body).toEqual(body);
    expect(result.head).toMatchObject({
      status: 201,
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "content-disposition": "attachment; filename=guest.bin",
      },
      cookies: [
        "mines_guest_one=a; Path=/api/guest; HttpOnly",
        "mines_guest_two=b; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/api/guest",
      ],
    });
    if (result.head.type !== "head") throw new Error("Missing head");
    for (const name of [
      "connection",
      "etag",
      "x-private",
      "set-cookie",
      "content-length",
      "transfer-encoding",
    ])
      expect(result.head.headers[name]).toBeUndefined();
  }),
);

it.live("streams bounded chunks, waits for each ACK, and ends without a head or end ACK", () =>
  Effect.promise(async () => {
    const body = Buffer.alloc(GUEST_PROXY_CHUNK_BYTES * 3 + 17, 97);
    await using client = await fixture((incoming, outgoing) => {
      if (incoming.url === "/api/guest/item") outgoing.end(body);
      else outgoing.writeHead(204).end();
    });
    const id = "guest_request_stream";
    client.send(request(id, { path: "/api/guest/item" }));
    expect(await client.frames.take()).toMatchObject({ type: "head", id });
    const chunks: Buffer[] = [];
    for (let index = 0; Buffer.concat(chunks).length < body.length; index++) {
      const frame = await client.frames.take();
      expect(frame).toMatchObject({ type: "chunk", id });
      if (frame.type !== "chunk") throw new Error("Missing chunk");
      const chunk = Buffer.from(frame.body, "base64");
      expect(chunk.length).toBeLessThanOrEqual(GUEST_PROXY_CHUNK_BYTES);
      chunks.push(chunk);
      const barrierId = `guest_barrier_${String(index).padStart(4, "0")}`;
      client.send(request(barrierId));
      expect(await client.frames.take()).toMatchObject({
        type: "head",
        id: barrierId,
        status: 204,
      });
      expect(await client.frames.take()).toEqual({ type: "end", id: barrierId });
      expect(
        client.observed.filter((value) => value.id === id && value.type === "chunk"),
      ).toHaveLength(index + 1);
      client.ack(id);
    }
    expect(await client.frames.take()).toEqual({ type: "end", id });
    expect(Buffer.concat(chunks)).toEqual(body);
  }),
);

it.live("admits a redeem request while more than eight SSE streams remain open", () =>
  Effect.promise(async () => {
    const streams: NodeHttp.ServerResponse[] = [];
    const closed = inbox<void>();
    await using client = await fixture((incoming, outgoing) => {
      if (incoming.url === "/api/guest/stream") {
        streams.push(outgoing);
        outgoing.once("close", () => closed.push(undefined));
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.write("data: ready\n\n");
      } else {
        incoming.resume();
        incoming.once("end", () => outgoing.writeHead(204).end());
      }
    });
    const ids = Array.from(
      { length: 9 },
      (_, index) => `guest_sse_${String(index).padStart(8, "0")}`,
    );
    for (const id of ids) {
      client.send(request(id, { path: "/api/guest/stream" }));
      expect(await client.frames.take()).toMatchObject({ type: "head", id });
      expect(await client.frames.take()).toMatchObject({ type: "chunk", id });
      client.ack(id);
    }
    client.send(
      request("guest_request_redeem", { method: "POST", path: "/api/guest/redeem", body: "e30=" }),
    );
    expect((await response(client, "guest_request_redeem")).head).toMatchObject({ status: 204 });
    expect(streams).toHaveLength(9);
    expect(streams.every((stream) => !stream.destroyed)).toBe(true);
    for (const id of ids) client.send({ type: "cancel", id });
    await Promise.all(ids.map(() => closed.take()));
  }),
);

it.live("cancels before headers, during reads and ACK waits, and on channel disposal", () =>
  Effect.promise(async () => {
    const arrived = inbox<NodeHttp.ServerResponse>();
    const closed = inbox<void>();
    await using client = await fixture((_incoming, outgoing) => {
      outgoing.once("close", () => closed.push(undefined));
      arrived.push(outgoing);
    });
    for (const phase of ["headers", "read", "ack"] as const) {
      const id = `guest_cancel_${phase.padEnd(8, "_")}`;
      client.send(request(id, { path: "/api/guest/stream" }));
      const outgoing = await arrived.take();
      if (phase !== "headers") {
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        outgoing.flushHeaders();
        expect(await client.frames.take()).toMatchObject({ type: "head", id });
      }
      if (phase === "ack") {
        outgoing.write("data: held\n\n");
        expect(await client.frames.take()).toMatchObject({ type: "chunk", id });
      }
      client.send({ type: "cancel", id });
      await closed.take();
    }
    client.send(request("guest_channel_close", { path: "/api/guest/stream" }));
    const outgoing = await arrived.take();
    outgoing.writeHead(200).write("held");
    expect(await client.frames.take()).toMatchObject({ type: "head" });
    expect(await client.frames.take()).toMatchObject({ type: "chunk" });
    client.socket.close();
    await Promise.all([closed.take(), client.disconnected]);
    expect(
      client.observed.filter((frame) => frame.type === "error" || frame.type === "end"),
    ).toEqual([]);
    client.unbind();
    client.unbind();
  }),
);

it.live(
  "rejects forbidden paths, IPs, noncanonical bodies and redirects before reaching owner APIs",
  () =>
    Effect.promise(async () => {
      let ownerCalls = 0;
      await using client = await fixture((incoming, outgoing) => {
        if (incoming.url === "/api/guest/session")
          outgoing.writeHead(302, { location: "/api/owner" }).end();
        else {
          ownerCalls++;
          outgoing.end("owner");
        }
      });
      const cases: Partial<GuestProxyRequest>[] = [
        { path: "/api/owner" },
        { path: "//elsewhere.test/api/guest/session" },
        { path: "/api/guest/../owner" },
        { path: "/api/guest/%73ession" },
        { path: "/api/guest/session", method: "POST" },
        { ipAddress: "198.51.100.25, 10.0.0.1" },
        { ipAddress: "fe80::1%en0" },
        { method: "POST", path: "/api/guest/messages", body: "Zh==" },
        { body: "" },
        {},
      ];
      for (const [index, overrides] of cases.entries()) {
        const id = `guest_invalid_${String(index).padStart(4, "0")}`;
        client.send(request(id, overrides));
        expect(await client.frames.take()).toEqual({ type: "error", id });
      }
      expect(ownerCalls).toBe(0);
    }),
);

it.live("bounds decoded request bodies and aggregate held uploads and recovers after headers", () =>
  Effect.promise(async () => {
    const uploaded = inbox<NodeHttp.ServerResponse>();
    await using client = await fixture((incoming, outgoing) => {
      incoming.resume();
      incoming.once("end", () => uploaded.push(outgoing));
    });
    const body = Buffer.alloc(GUEST_PROXY_MAX_REQUEST_BYTES).toString("base64");
    const upload = (id: string, value = body) =>
      client.send(request(id, { method: "POST", path: "/api/guest/messages", body: value }));
    const held: NodeHttp.ServerResponse[] = [];
    for (let index = 0; index < 3; index++) {
      upload(`guest_upload_${String(index).padStart(4, "0")}`);
      held.push(await uploaded.take());
    }
    upload("guest_upload_budget");
    expect(await client.frames.take()).toEqual({ type: "error", id: "guest_upload_budget" });
    upload(
      "guest_upload_oversize",
      Buffer.alloc(GUEST_PROXY_MAX_REQUEST_BYTES + 1).toString("base64"),
    );
    expect(await client.frames.take()).toEqual({ type: "error", id: "guest_upload_oversize" });
    held[0]!.writeHead(204).end();
    expect((await response(client, "guest_upload_0000")).head).toMatchObject({ status: 204 });
    upload("guest_upload_recovered");
    const recovered = await uploaded.take();
    recovered.writeHead(204).end();
    await response(client, "guest_upload_recovered");
  }),
);

it.live(
  "closes malformed or duplicate request channels without dispatching extra HTTP requests",
  () =>
    Effect.promise(async () => {
      for (const invalid of [
        "not-json",
        { type: "request", id: "invalid" },
        {
          ...request("guest_bad_padding"),
          method: "POST",
          path: "/api/guest/messages",
          body: "a===",
        },
      ]) {
        let calls = 0;
        await using client = await fixture((_incoming, outgoing) => {
          calls++;
          outgoing.end();
        });
        client.send(invalid);
        await client.disconnected;
        expect(calls).toBe(0);
      }
      const arrived = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      let calls = 0;
      await using client = await fixture((_incoming, outgoing) => {
        calls++;
        outgoing.once("close", () => closed.resolve());
        arrived.resolve();
      });
      client.send(request("guest_duplicate_id"));
      await arrived.promise;
      client.send(request("guest_duplicate_id"));
      await Promise.all([client.disconnected, closed.promise]);
      expect(calls).toBe(1);
    }),
);

it("admits queued fanout above 2 MiB and closes the channel at the 24 MiB send bound", async () => {
  const frames = inbox<GuestProxyHostFrame>();
  class Socket extends EventTarget {
    bufferedAmount = 3 * 1024 * 1024;
    readyState: number = WebSocket.OPEN;
    send(text: string) {
      frames.push(decodeFrame(text));
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
    receive(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 204 }));
  const socket = new Socket();
  const unbind = bindGuestProxyBridge(socket as unknown as WebSocket, 1234);
  try {
    socket.receive(request("guest_queued_fanout"));
    expect(await frames.take()).toMatchObject({ type: "head", id: "guest_queued_fanout" });
    expect(await frames.take()).toEqual({ type: "end", id: "guest_queued_fanout" });
    socket.bufferedAmount = 24 * 1024 * 1024;
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.receive(request("guest_queued_overflow"));
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    unbind();
  }
});

it.live("expires missing headers while an established SSE response survives the deadline", () =>
  Effect.promise(async () => {
    const fetchStarted = Promise.withResolvers<void>();
    await using client = await fixture((_incoming, outgoing) => outgoing.end());
    using fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_input, options) => {
      fetchStarted.resolve();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    vi.useFakeTimers();
    try {
      client.send(request("guest_header_timeout"));
      await fetchStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await client.frames.take()).toEqual({ type: "error", id: "guest_header_timeout" });
      const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      fetch.mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(value) {
                controller.resolve(value);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      client.send(request("guest_sse_no_timeout", { path: "/api/guest/stream" }));
      expect(await client.frames.take()).toMatchObject({
        type: "head",
        id: "guest_sse_no_timeout",
      });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      (await controller.promise).enqueue(new TextEncoder().encode("data: alive\n\n"));
      expect(await client.frames.take()).toMatchObject({
        type: "chunk",
        id: "guest_sse_no_timeout",
      });
      client.ack("guest_sse_no_timeout");
      (await controller.promise).close();
      expect(await client.frames.take()).toEqual({ type: "end", id: "guest_sse_no_timeout" });
    } finally {
      vi.useRealTimers();
    }
  }),
);
