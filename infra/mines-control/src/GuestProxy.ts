// @effect-diagnostics-next-line nodeBuiltinImport:off -- This helper owns the native HTTP/WebSocket transport boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The native HTTP handler delegates requests to this helper.
import type * as NodeHttp from "node:http";
import {
  GUEST_PROXY_CHUNK_BYTES,
  GUEST_PROXY_MAX_PENDING,
  GUEST_PROXY_MAX_REQUEST_BYTES,
  GuestProxyHostFrame,
  guestProxyPath,
  type GuestProxyControlFrame,
} from "@t3tools/shared/guestProxy";
import * as Schema from "effect/Schema";

interface GuestRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly destroyed: boolean;
  readonly once: (event: "aborted", listener: () => void) => unknown;
  readonly removeListener: (event: "aborted", listener: () => void) => unknown;
}

interface GuestResponse {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly writeHead: (status: number, headers: Record<string, string | Array<string>>) => unknown;
  readonly flushHeaders: () => void;
  readonly write: (body: Uint8Array) => boolean;
  readonly end: (body?: string) => unknown;
  readonly destroy: () => unknown;
  readonly once: (event: "close" | "drain", listener: () => void) => unknown;
  readonly removeListener: (event: "close" | "drain", listener: () => void) => unknown;
}

interface HostConnection {
  readonly send: (frame: GuestProxyControlFrame) => void;
  readonly close: () => void;
}

interface GuestProxyConfig {
  readonly publicUrl: string | null;
  readonly trustedProxies: ReadonlyArray<string>;
}

const normalizeIp = (value: string) =>
  value.startsWith("::ffff:") && NodeNet.isIP(value.slice(7)) === 4 ? value.slice(7) : value;
const literalIp = (value: string) => !value.includes("%") && NodeNet.isIP(value) !== 0;
const devicePattern = /^[a-zA-Z0-9_-]{16,128}$/;
const cookiePattern = /^mines_guest_[a-zA-Z0-9_-]+$/;
const decodeHostFrame = Schema.decodeUnknownSync(GuestProxyHostFrame);
const requestHeaders = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "range",
  "if-none-match",
]);
const responseHeaders = new Set([
  "content-type",
  "content-disposition",
  "cache-control",
  "x-accel-buffering",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "content-range",
  "accept-ranges",
  "etag",
]);
const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_TOTAL = 1024;
const GUEST_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

export function parseGuestProxyConfig(publicUrl?: string, trustedProxies = ""): GuestProxyConfig {
  let origin: string | null = null;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("MINES_GUEST_PUBLIC_URL must be an HTTPS origin.");
    origin = url.origin;
  }
  const addresses = trustedProxies
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (addresses.some((value) => !literalIp(value)))
    throw new Error("MINES_GUEST_TRUSTED_PROXIES must contain exact IP addresses.");
  return { publicUrl: origin, trustedProxies: addresses.map(normalizeIp) };
}

export function guestClientIp(
  request: Pick<GuestRequest, "headers" | "socket">,
  trustedProxies: ReadonlyArray<string>,
): string | null {
  const remote = request.socket.remoteAddress;
  if (!remote || !literalIp(remote)) return null;
  const socketIp = normalizeIp(remote);
  if (!trustedProxies.includes(socketIp)) return socketIp;
  const observed = request.headers["x-real-ip"];
  return typeof observed === "string" && literalIp(observed) ? normalizeIp(observed) : null;
}

function forwardHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const forwarded: Record<string, string> = {};
  for (const name of requestHeaders) {
    const value = headers[name];
    if (typeof value === "string") forwarded[name] = value;
  }
  const cookies = headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .filter((value) => cookiePattern.test(value.slice(0, value.indexOf("="))));
  if (cookies?.length) forwarded.cookie = cookies.join("; ");
  return forwarded;
}

function forwardCookies(cookies: ReadonlyArray<string>, deviceId: string) {
  return cookies.flatMap((cookie) => {
    if (/[\r\n\0]/.test(cookie)) return [];
    const [pair, ...attributes] = cookie.split(";");
    if (!pair || !cookiePattern.test(pair.slice(0, pair.indexOf("=")))) return [];
    if (!attributes.some((value) => /^path=\/api\/guest$/i.test(value.trim()))) return [];
    const rewritten = attributes
      .filter((value) => !/^domain=/i.test(value.trim()))
      .map((value) =>
        /^path=/i.test(value.trim()) ? ` Path=/api/guest/hosts/${deviceId}` : value,
      );
    return [[pair, ...rewritten].join(";")];
  });
}

function failResponse(response: GuestResponse, status: number) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) response.destroy();
  else {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "guest_proxy_unavailable" }));
  }
}

export function makeGuestProxy(config: GuestProxyConfig) {
  interface Pending {
    readonly request: GuestRequest;
    readonly response: GuestResponse;
    readonly started: number;
    readonly cancel: () => void;
    readonly drain: () => void;
    forwarded: boolean;
    headed: boolean;
    draining: boolean;
  }
  interface Host {
    readonly connection: HostConnection;
    readonly pending: Map<string, Pending>;
  }
  const hosts = new Map<string, Host>();
  let bufferedBytes = 0;
  let pendingCount = 0;
  let pulses = 0;

  function remove(host: Host, id: string) {
    const pending = host.pending.get(id);
    if (!pending) return;
    host.pending.delete(id);
    pendingCount--;
    pending.request.removeListener("aborted", pending.cancel);
    pending.response.removeListener("close", pending.cancel);
    pending.response.removeListener("drain", pending.drain);
  }

  function send(host: Host, frame: GuestProxyControlFrame) {
    try {
      host.connection.send(frame);
    } catch {
      disconnect(host, 503);
    }
  }

  function disconnect(host: Host, status: number) {
    for (const [id, pending] of host.pending) {
      remove(host, id);
      failResponse(pending.response, status);
    }
    for (const [id, current] of hosts) if (current === host) hosts.delete(id);
  }

  function rejectHost(host: Host) {
    disconnect(host, 502);
    host.connection.close();
  }

  return {
    publicUrl: config.publicUrl,
    connect(deviceId: string, connection: HostConnection) {
      if (!config.publicUrl || !devicePattern.test(deviceId))
        throw new Error("Guest proxy disabled or invalid host.");
      const previous = hosts.get(deviceId);
      if (previous) {
        disconnect(previous, 503);
        previous.connection.close();
      }
      const host: Host = { connection, pending: new Map() };
      hosts.set(deviceId, host);
      return {
        disconnect: () => disconnect(host, 503),
        receive(value: unknown) {
          if (hosts.get(deviceId) !== host) return;
          try {
            const frame = decodeHostFrame(value);
            const pending = host.pending.get(frame.id);
            // Cancellation can race with already-sent host frames.
            if (!pending) return;
            const response = pending.response;
            if (!pending.forwarded) throw new Error("Unexpected host frame.");
            if (frame.type === "error") {
              remove(host, frame.id);
              failResponse(response, 502);
            } else if (frame.type === "head") {
              if (
                pending.headed ||
                !Number.isInteger(frame.status) ||
                frame.status < 200 ||
                frame.status > 599
              )
                throw new Error("Invalid response head.");
              if (JSON.stringify(frame).length > 32 * 1024)
                throw new Error("Response head too large.");
              const headers: Record<string, string | Array<string>> = {
                "cache-control": "no-store",
              };
              for (const [name, value] of Object.entries(frame.headers))
                if (responseHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
              headers["cache-control"] = "no-store, no-transform";
              const cookies = forwardCookies(frame.cookies, deviceId);
              if (cookies.length) headers["set-cookie"] = cookies;
              headers["x-content-type-options"] = "nosniff";
              const policy = headers["content-security-policy"];
              // Registered hosts cannot run scripts with the public origin's cookies.
              headers["content-security-policy"] =
                typeof policy === "string"
                  ? `${policy}, ${GUEST_SANDBOX}`
                  : `default-src 'none'; ${GUEST_SANDBOX}`;
              response.writeHead(frame.status, headers);
              response.flushHeaders();
              pending.headed = true;
            } else if (frame.type === "chunk") {
              if (
                !pending.headed ||
                pending.draining ||
                frame.body.length > Math.ceil(GUEST_PROXY_CHUNK_BYTES / 3) * 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.body)
              )
                throw new Error("Invalid response chunk.");
              const body = Buffer.from(frame.body, "base64");
              if (body.length > GUEST_PROXY_CHUNK_BYTES)
                throw new Error("Response chunk too large.");
              pending.draining = true;
              if (response.write(body)) pending.drain();
              else response.once("drain", pending.drain);
            } else {
              if (!pending.headed || pending.draining) throw new Error("Unexpected response end.");
              remove(host, frame.id);
              response.end();
            }
          } catch {
            rejectHost(host);
          }
        },
      };
    },
    pulse() {
      pulses++;
      for (const host of hosts.values())
        for (const [id, pending] of host.pending) {
          if (pending.headed || pulses - pending.started < 2) continue;
          remove(host, id);
          if (pending.forwarded) send(host, { type: "cancel", id });
          failResponse(pending.response, 504);
        }
    },
    async handle(request: GuestRequest, response: GuestResponse): Promise<boolean> {
      const path = request.url ?? "/";
      if (path.split("?", 1)[0] === "/v1/guest-config") {
        if (!config.publicUrl || request.method !== "GET") failResponse(response, 404);
        else {
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ publicUrl: config.publicUrl }));
        }
        return true;
      }
      if (!path.startsWith("/api/guest/")) return false;
      const match = /^\/api\/guest\/hosts\/([a-zA-Z0-9_-]{16,128})(\/.*)$/.exec(path);
      const deviceId = match?.[1];
      const targetPath = match?.[2] ? `/api/guest${match[2]}` : "";
      const method = request.method ?? "";
      if (
        !config.publicUrl ||
        !deviceId ||
        !guestProxyPath(targetPath, method) ||
        (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE")
      ) {
        failResponse(response, 404);
        return true;
      }
      const ipAddress = guestClientIp(request, config.trustedProxies);
      if (!ipAddress) {
        failResponse(response, 400);
        return true;
      }
      const host = hosts.get(deviceId);
      if (!host) {
        failResponse(response, 503);
        return true;
      }
      if (host.pending.size >= GUEST_PROXY_MAX_PENDING || pendingCount >= MAX_PENDING_TOTAL) {
        failResponse(response, 429);
        return true;
      }
      const declared = request.headers["content-length"];
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > GUEST_PROXY_MAX_REQUEST_BYTES)
      ) {
        failResponse(response, 413);
        return true;
      }
      const id = NodeCrypto.randomUUID();
      const pending: Pending = {
        request,
        response,
        started: pulses,
        headed: false,
        draining: false,
        forwarded: false,
        cancel: () => {
          if (!host.pending.has(id)) return;
          remove(host, id);
          if (pending.forwarded) send(host, { type: "cancel", id });
        },
        drain: () => {
          if (!host.pending.has(id)) return;
          pending.draining = false;
          send(host, { type: "ack", id });
        },
      };
      host.pending.set(id, pending);
      pendingCount++;
      request.once("aborted", pending.cancel);
      response.once("close", pending.cancel);
      const chunks: Array<Buffer> = [];
      let size = 0;
      try {
        for await (const value of request) {
          if (!host.pending.has(id)) break;
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (
            size > GUEST_PROXY_MAX_REQUEST_BYTES ||
            bufferedBytes + chunk.length > MAX_BUFFERED_BODY_BYTES
          ) {
            remove(host, id);
            failResponse(response, size > GUEST_PROXY_MAX_REQUEST_BYTES ? 413 : 503);
            return true;
          }
          if (method === "GET" && size > 0) {
            remove(host, id);
            failResponse(response, 400);
            return true;
          }
          chunks.push(chunk);
          bufferedBytes += chunk.length;
        }
        if (!host.pending.has(id)) return true;
        const body = chunks.length ? Buffer.concat(chunks).toString("base64") : undefined;
        pending.forwarded = true;
        send(host, {
          type: "request",
          id,
          method,
          path: targetPath,
          headers: forwardHeaders(request.headers),
          ...(body === undefined ? {} : { body }),
          ipAddress,
        });
      } catch {
        pending.cancel();
        failResponse(response, 400);
      } finally {
        for (const chunk of chunks) bufferedBytes -= chunk.length;
      }
      return true;
    },
  };
}
