import * as NodeNet from "node:net";
import {
  GUEST_PROXY_CHUNK_BYTES,
  GUEST_PROXY_MAX_PENDING,
  GUEST_PROXY_MAX_REQUEST_BYTES,
  GuestProxyControlFrame,
  type GuestProxyHostFrame,
  guestProxyPath,
} from "@t3tools/shared/guestProxy";
import * as Schema from "effect/Schema";
import { guestProxyHeaders } from "./guestProxyTrust.ts";

// The channel can queue one base64 chunk for each of 256 active guest requests.
const MAX_BUFFERED_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES = Math.ceil(GUEST_PROXY_MAX_REQUEST_BYTES / 3) * 4 + 1024 * 1024;
const decodeControl = Schema.decodeUnknownSync(Schema.fromJsonString(GuestProxyControlFrame));
const requestHeaders = new Set([
  "accept",
  "content-type",
  "cookie",
  "range",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
]);
const responseHeaders = new Set([
  "content-type",
  "content-disposition",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options",
  "x-accel-buffering",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
]);

interface PendingRequest {
  readonly controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  acknowledge?: ((accepted: boolean) => void) | undefined;
  headerDeadline?: ReturnType<typeof setTimeout>;
  bodyBytes: number;
}

export function bindGuestProxyBridge(socket: WebSocket, port: number): () => void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Invalid guest proxy port");

  const pending = new Map<string, PendingRequest>();
  let bufferedBodyBytes = 0;
  let closed = false;

  const releaseBody = (request: PendingRequest) => {
    bufferedBodyBytes -= request.bodyBytes;
    request.bodyBytes = 0;
  };
  const cancel = (id: string, request: PendingRequest) => {
    pending.delete(id);
    clearTimeout(request.headerDeadline);
    request.controller.abort();
    request.acknowledge?.(false);
    request.acknowledge = undefined;
    if (request.reader) void request.reader.cancel().catch(() => undefined);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", cleanup);
    socket.removeEventListener("error", cleanup);
    for (const [id, request] of pending) cancel(id, request);
  };
  const fail = () => {
    cleanup();
    socket.close();
  };
  const send = (frame: GuestProxyHostFrame) => {
    if (closed) return false;
    const text = JSON.stringify(frame);
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES
    ) {
      fail();
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      fail();
      return false;
    }
  };
  const sendAcknowledged = (request: PendingRequest, frame: GuestProxyHostFrame) =>
    new Promise<boolean>((resolve) => {
      request.acknowledge = resolve;
      if (!send(frame)) {
        request.acknowledge = undefined;
        resolve(false);
      }
    });

  const forward = async (
    id: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    headers: Headers,
    body: Buffer | undefined,
    request: PendingRequest,
  ) => {
    const active = () => !closed && pending.get(id) === request;
    try {
      // @effect-diagnostics-next-line globalTimers:off -- This native transport deadline ends at response headers; SSE has no total timeout.
      request.headerDeadline = setTimeout(() => request.controller.abort(), 15_000);
      let response: Response;
      try {
        // @effect-diagnostics-next-line globalFetch:off -- The authenticated WebSocket adapter streams a fixed loopback target with explicit cancellation.
        response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
          redirect: "error",
          signal: request.controller.signal,
          ...(body === undefined ? {} : { body }),
        });
      } finally {
        clearTimeout(request.headerDeadline);
        body = undefined;
        releaseBody(request);
      }
      if (!active()) {
        if (response.body) await response.body.cancel();
        return;
      }
      const connectionHeaders = new Set(
        (response.headers.get("connection") ?? "")
          .split(",")
          .map((name) => name.trim().toLowerCase()),
      );
      const forwardedHeaders: Record<string, string> = {};
      for (const name of responseHeaders) {
        const value = response.headers.get(name);
        if (value !== null && !connectionHeaders.has(name)) {
          if (value.length > 16_384) throw new Error("Invalid guest response headers");
          forwardedHeaders[name] = value;
        }
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 8 || cookies.some((cookie) => cookie.length > 4096))
        throw new Error("Invalid guest response cookies");
      const head = {
        type: "head",
        id,
        status: response.status,
        headers: forwardedHeaders,
        cookies: connectionHeaders.has("set-cookie") ? [] : cookies,
      } satisfies GuestProxyHostFrame;
      if (Buffer.byteLength(JSON.stringify(head)) > 32 * 1024)
        throw new Error("Invalid guest response head");
      if (response.body) request.reader = response.body.getReader();
      if (!send(head)) return;
      while (active() && request.reader) {
        const part = await request.reader.read();
        if (part.done) break;
        for (let offset = 0; offset < part.value.byteLength; offset += GUEST_PROXY_CHUNK_BYTES) {
          if (!active()) return;
          const chunk = part.value.subarray(offset, offset + GUEST_PROXY_CHUNK_BYTES);
          if (
            !(await sendAcknowledged(request, {
              type: "chunk",
              id,
              body: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(
                "base64",
              ),
            }))
          )
            return;
        }
      }
      if (active()) send({ type: "end", id });
    } catch {
      if (active()) send({ type: "error", id });
    } finally {
      if (pending.get(id) === request) pending.delete(id);
      clearTimeout(request.headerDeadline);
      request.controller.abort();
      request.acknowledge?.(false);
      request.reader?.releaseLock();
      releaseBody(request);
    }
  };

  function onMessage(event: MessageEvent) {
    if (closed) return;
    try {
      if (
        typeof event.data !== "string" ||
        Buffer.byteLength(event.data) > MAX_CONTROL_FRAME_BYTES
      ) {
        fail();
        return;
      }
      const frame = decodeControl(event.data);
      if (frame.type === "ack") {
        const request = pending.get(frame.id);
        const acknowledge = request?.acknowledge;
        if (request) request.acknowledge = undefined;
        acknowledge?.(true);
        return;
      }
      if (frame.type === "cancel") {
        const request = pending.get(frame.id);
        if (request) cancel(frame.id, request);
        return;
      }
      if (pending.has(frame.id)) {
        fail();
        return;
      }
      if (
        pending.size >= GUEST_PROXY_MAX_PENDING ||
        !guestProxyPath(frame.path, frame.method) ||
        frame.ipAddress.includes("%") ||
        NodeNet.isIP(frame.ipAddress) === 0 ||
        (frame.method === "GET" && frame.body !== undefined)
      ) {
        send({ type: "error", id: frame.id });
        return;
      }
      const bodyBytes =
        frame.body === undefined
          ? 0
          : (frame.body.length / 4) * 3 -
            (frame.body.endsWith("==") ? 2 : frame.body.endsWith("=") ? 1 : 0);
      if (
        bodyBytes > GUEST_PROXY_MAX_REQUEST_BYTES ||
        bufferedBodyBytes + bodyBytes > MAX_REQUEST_BODY_BYTES
      ) {
        send({ type: "error", id: frame.id });
        return;
      }
      const body = frame.body === undefined ? undefined : Buffer.from(frame.body, "base64");
      if (body !== undefined && body.toString("base64") !== frame.body) {
        send({ type: "error", id: frame.id });
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(frame.headers)) {
        if (requestHeaders.has(name.toLowerCase())) headers.set(name, value);
      }
      for (const [name, value] of Object.entries(guestProxyHeaders(frame.ipAddress)))
        headers.set(name, value);
      const request: PendingRequest = { controller: new AbortController(), bodyBytes };
      pending.set(frame.id, request);
      bufferedBodyBytes += bodyBytes;
      void forward(frame.id, frame.method, frame.path, headers, body, request);
    } catch {
      fail();
    }
  }

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", cleanup);
  socket.addEventListener("error", cleanup);
  if (socket.readyState !== WebSocket.OPEN) cleanup();
  return cleanup;
}
