import { PeerResourceRequest, PeerRpcOpen } from "@t3tools/contracts/minesPeer";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Schema from "effect/Schema";

const MAX_RESOURCE_BYTES = 12 * 1024 * 1024 - 64 * 1024;
const MAX_QUEUED_RPC_BYTES = 8 * 1024 * 1024;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decodeRequest = Schema.decodeUnknownSync(PeerResourceRequest);
const decodeOpen = Schema.decodeUnknownSync(PeerRpcOpen);

/** A peer may address only this server's HTTP surface; never arbitrary URLs or proxy targets. */
export function peerLoopbackUrl(port: number, path: string, rpc = false): URL {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid peer port");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n\0]/.test(path))
    throw new Error("Invalid peer path");
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash)
    throw new Error("Invalid peer origin");
  if (
    rpc
      ? url.pathname !== "/ws"
      : !(
          url.pathname.startsWith("/api/") ||
          url.pathname.startsWith("/.well-known/") ||
          url.pathname === "/oauth/token"
        )
  )
    throw new Error("Peer path is not an application resource");
  if (rpc) {
    if (
      url.searchParams.getAll("wsTicket").length !== 1 ||
      !url.searchParams.get("wsTicket") ||
      url.searchParams.has("dpop")
    )
      throw new Error("A scoped websocket ticket is required");
    url.protocol = "ws:";
  }
  return url;
}

function peerRequestHeaders(input: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  // Credentials are the connecting device's own scoped bearer token. Never add a host token.
  const allowed = new Set([
    "authorization",
    "content-type",
    "accept",
    "range",
    "if-none-match",
    "if-modified-since",
    "x-mines-client-surface",
    "x-mines-client-version",
    ORCHESTRATION_PROTOCOL_HEADER,
  ]);
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (allowed.has(name) && (name !== "authorization" || /^Bearer [^\s]+$/i.test(value)))
      headers.set(key, value);
  }
  return headers;
}

/** Bind only after signed SDP and approved device-key verification. Existing HTTP/RPC auth remains authoritative. */
export function bindPeerLoopback(session: PeerSession, port: number): () => void {
  const controller = new AbortController();
  let socket: WebSocket | undefined;
  let opening = false;
  let queuedBytes = 0;
  const queued: string[] = [];
  let inFlightResources = 0;
  let closed = false;
  let unsubscribeRpc = () => {};
  let unsubscribeResource = () => {};
  let openDeadline: ReturnType<typeof setTimeout> | undefined;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearTimeout(openDeadline);
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    readers.clear();
    unsubscribeRpc();
    unsubscribeResource();
    socket?.close();
    queued.length = 0;
  };
  const fail = () => {
    cleanup();
    session.close();
  };
  const writeRpc = (text: string) => {
    if (!socket || socket.bufferedAmount + Buffer.byteLength(text) > MAX_QUEUED_RPC_BYTES) {
      fail();
      return;
    }
    socket.send(text);
  };
  unsubscribeRpc = session.subscribe("rpc", (bytes) => {
    if (closed) return;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!opening) {
        const request = decodeOpen(JSON.parse(text));
        const url = peerLoopbackUrl(port, request.path, true);
        opening = true;
        socket = new WebSocket(url);
        // @effect-diagnostics-next-line globalTimers:off -- Native socket callbacks own this deadline and cancel it on open or disposal.
        openDeadline = setTimeout(fail, 15_000);
        socket.addEventListener("open", () => {
          clearTimeout(openDeadline);
          if (closed) return;
          for (const frame of queued) {
            if (closed) break;
            writeRpc(frame);
          }
          queued.length = 0;
          queuedBytes = 0;
        });
        socket.addEventListener("message", (event) => {
          if (closed) return;
          if (typeof event.data !== "string") {
            fail();
            return;
          }
          if (Buffer.byteLength(event.data) > MAX_QUEUED_RPC_BYTES) {
            fail();
            return;
          }
          void session.send("rpc", new TextEncoder().encode(event.data)).catch(fail);
        });
        socket.addEventListener("error", fail);
        socket.addEventListener("close", fail);
      } else if (socket?.readyState === WebSocket.OPEN) {
        writeRpc(text);
      } else {
        queuedBytes += bytes.byteLength;
        if (queuedBytes > MAX_QUEUED_RPC_BYTES) {
          fail();
          return;
        }
        queued.push(text);
      }
    } catch {
      fail();
    }
  });
  if (closed) {
    unsubscribeRpc();
    return cleanup;
  }
  const resource = async (bytes: Uint8Array) => {
    if (closed) return;
    const request = decodeRequest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (inFlightResources >= 8) {
      await session.send(
        "resource",
        encode({ id: request.id, status: 429, headers: {}, encoding: "base64", body: "" }),
      );
      return;
    }
    const url = peerLoopbackUrl(port, request.path);
    const body = request.body === undefined ? undefined : Buffer.from(request.body, "base64");
    if (body && body.byteLength > MAX_RESOURCE_BYTES)
      throw new Error("Peer resource body is too large");
    inFlightResources += 1;
    try {
      // @effect-diagnostics-next-line globalFetch:off - Native transport callback uses the session AbortSignal and bounded loopback response streaming.
      const response = await fetch(url, {
        method: request.method,
        headers: peerRequestHeaders(request.headers),
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        ...(body === undefined ? {} : { body }),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        readers.add(reader);
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_RESOURCE_BYTES) {
              await reader.cancel();
              throw new Error("Peer resource response requires ranges");
            }
            chunks.push(part.value);
          }
        } finally {
          readers.delete(reader);
          reader.releaseLock();
        }
      }
      const responseHeaders: Record<string, string> = {};
      for (const key of [
        "content-type",
        "content-range",
        "accept-ranges",
        "etag",
        "cache-control",
      ]) {
        const value = response.headers.get(key);
        if (value !== null) responseHeaders[key] = value;
      }
      if (!closed)
        await session.send(
          "resource",
          encode({
            id: request.id,
            status: response.status,
            headers: responseHeaders,
            encoding: "base64",
            body: Buffer.concat(chunks).toString("base64"),
          }),
        );
    } catch {
      if (!closed)
        await session.send(
          "resource",
          encode({ id: request.id, status: 502, headers: {}, encoding: "base64", body: "" }),
        );
    } finally {
      inFlightResources -= 1;
    }
  };
  unsubscribeResource = session.subscribe("resource", (bytes) => {
    void resource(bytes).catch(fail);
  });
  void session.closed.then(cleanup, cleanup);
  return cleanup;
}
