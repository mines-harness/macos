import {
  PeerError,
  PeerResourceRequest,
  PeerResourceResponse,
  PeerRpcOpen,
} from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import * as Socket from "effect/socket/Socket";

const decodeResponse = Schema.decodeUnknownSync(PeerResourceResponse);
const decodeRequest = Schema.decodeUnknownSync(PeerResourceRequest);
const decodeOpen = Schema.decodeUnknownSync(PeerRpcOpen);
const encodeOpen = Schema.encodeSync(Schema.fromJsonString(PeerRpcOpen));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fetches = new WeakMap<PeerSession, typeof fetch>();

export function peerFetch(session: PeerSession, baseUrl: string): typeof fetch {
  const existing = fetches.get(session);
  if (existing) return existing;
  const origin = new URL(baseUrl).origin;
  let sequence = 0;
  const pending = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: unknown) => void }
  >();
  const unsubscribe = session.subscribe("resource", (bytes) => {
    try {
      const value = decodeResponse(JSON.parse(decoder.decode(bytes)));
      const entry = pending.get(value.id);
      if (!entry) return;
      const body = Result.getOrThrow(Base64.decode(value.body));
      const response = new Response(
        [101, 204, 205, 304].includes(value.status) ? null : body.slice().buffer,
        {
          status: value.status,
          headers: value.headers,
        },
      );
      pending.delete(value.id);
      entry.resolve(response);
    } catch {
      session.close();
    }
  });
  void session.closed.then(() => {
    unsubscribe();
    for (const entry of pending.values()) entry.reject(new PeerError({ code: "closed" }));
    pending.clear();
    fetches.delete(session);
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    const target = new URL(request.url);
    if (target.origin !== origin || pending.size >= 32)
      throw new PeerError({ code: "direct-unavailable" });
    if (request.signal.aborted) throw request.signal.reason;
    const body =
      request.method === "GET" || request.method === "HEAD" || request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    if ((body?.length ?? 0) > 12 * 1024 * 1024 - 64 * 1024)
      throw new PeerError({ code: "frame-too-large" });
    if (request.signal.aborted) throw request.signal.reason;
    const id = `peer_request_${(++sequence).toString(36).padStart(12, "0")}`;
    const value = decodeRequest({
      id,
      method: request.method,
      path: target.pathname + target.search,
      headers: Object.fromEntries(request.headers.entries()),
      encoding: "base64",
      ...(body === undefined ? {} : { body: Base64.encode(body) }),
    });
    let reject!: (error: unknown) => void;
    const response = new Promise<Response>((resolve, fail) => {
      reject = fail;
      pending.set(id, { resolve, reject: fail });
    });
    const abort = () => {
      pending.delete(id);
      reject(request.signal.reason);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const [, received] = await Promise.all([
        session.send("resource", encoder.encode(JSON.stringify(value))),
        response,
      ]);
      return received;
    } finally {
      request.signal.removeEventListener("abort", abort);
      pending.delete(id);
    }
  };
  fetches.set(session, fetch);
  return fetch;
}

export function layerPeerSocket(
  session: PeerSession,
  socketUrl: string,
): Layer.Layer<Socket.Socket> {
  const url = new URL(socketUrl);
  const open = decodeOpen({
    type: "mines.rpc.open",
    path: url.pathname + url.search,
  });
  const openBytes = encoder.encode(encodeOpen(open));
  const acquire = Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        let unsubscribe = () => {};
        let finished = false;
        const readable = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              unsubscribe = session.subscribe("rpc", (data) => {
                if ((controller.desiredSize ?? 0) < data.length) {
                  session.close();
                  return;
                }
                controller.enqueue(data);
              });
              void session.closed.then(() => {
                if (!finished) {
                  finished = true;
                  controller.close();
                }
              });
            },
            cancel() {
              finished = true;
              unsubscribe();
              session.close();
            },
          },
          { highWaterMark: 16 * 1024 * 1024, size: (chunk) => chunk.length },
        );
        const writable = new WritableStream<Uint8Array>({
          write: (data) => session.send("rpc", data),
          close: () => session.close(),
          abort: () => session.close(),
        });
        await session.send("rpc", openBytes);
        return { readable, writable, unsubscribe };
      },
      catch: (cause) =>
        new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
    }),
    (stream) =>
      Effect.sync(() => {
        stream.unsubscribe();
        session.close();
      }),
  );
  return Layer.effect(Socket.Socket, Socket.fromTransformStream(acquire));
}
