import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The fixture exercises the native HTTP transport without listening on a port.
import * as NodeStream from "node:stream";
import { expect, it } from "@effect/vitest";
import { GUEST_PROXY_MAX_PENDING, type GuestProxyControlFrame } from "@t3tools/shared/guestProxy";
import { makeGuestProxy, parseGuestProxyConfig, guestClientIp } from "./GuestProxy.ts";

const deviceId = "device_identifier_001";
const base = `/api/guest/hosts/${deviceId}`;

function request(path = `${base}/session?share=share_001`, method = "GET", body = "") {
  return Object.assign(NodeStream.Readable.from(body ? [Buffer.from(body)] : []), {
    url: path,
    method,
    headers: {
      cookie: "account=private; mines_guest_share_001=guest-token",
      authorization: "Bearer private",
      "x-real-ip": "198.51.100.4",
      "x-forwarded-for": "198.51.100.5",
      "content-type": "application/json",
    },
    socket: { remoteAddress: "192.0.2.10" },
  });
}

class Response extends NodeEvents.EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  status = 0;
  headers: Record<string, string | Array<string>> = {};
  chunks: Array<Buffer> = [];
  writable = true;
  writeHead(status: number, headers: Record<string, string | Array<string>>) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  flushHeaders() {}
  write(chunk: Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
    return this.writable;
  }
  end(body?: string) {
    if (body) this.chunks.push(Buffer.from(body));
    this.writableEnded = true;
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
}

function fixture() {
  const proxy = makeGuestProxy(parseGuestProxyConfig("https://mines.gemstud.io"));
  const sent: Array<GuestProxyControlFrame> = [];
  let closed = false;
  const host = proxy.connect(deviceId, {
    send: (frame) => sent.push(frame),
    close: () => {
      closed = true;
    },
  });
  return {
    proxy,
    sent,
    host,
    closed: () => closed,
    id: (index = 0) => {
      const id = sent.filter((frame) => frame.type === "request")[index]?.id;
      if (!id) throw new Error("No forwarded request");
      return id;
    },
  };
}

it("keeps public guest routes disabled unless configured with an HTTPS origin", async () => {
  expect(parseGuestProxyConfig()).toEqual({ publicUrl: null, trustedProxies: [] });
  for (const value of [
    "http://mines.gemstud.io",
    "https://user:pass@example.com",
    "https://example.com/guest",
    "https://example.com?x=1",
  ]) {
    expect(() => parseGuestProxyConfig(value)).toThrow();
  }
  const response = new Response();
  await makeGuestProxy(parseGuestProxyConfig()).handle(request("/v1/guest-config"), response);
  expect(response.status).toBe(404);
});

it("trusts only configured immediate proxy addresses and never forwarded chains", () => {
  const input = request();
  expect(guestClientIp(input, [])).toBe("192.0.2.10");
  expect(guestClientIp(input, ["192.0.2.10"])).toBe("198.51.100.4");
  input.socket.remoteAddress = "::ffff:192.0.2.10";
  expect(guestClientIp(input, ["192.0.2.10"])).toBe("198.51.100.4");
  input.headers["x-real-ip"] = "198.51.100.4, 198.51.100.5";
  expect(guestClientIp(input, ["192.0.2.10"])).toBeNull();
  expect(() => parseGuestProxyConfig(undefined, "0.0.0.0/0")).toThrow();
});

it("forwards only guest routes, cookies and socket-observed IP", async () => {
  const test = fixture();
  for (const [path, method] of [
    [`${base}/../session`, "GET"],
    [`${base}/session`, "HEAD"],
    [`${base}/devices`, "GET"],
    [`${base}/messages`, "GET"],
    ["/api/guest/hosts/bad/session", "GET"],
  ]) {
    const response = new Response();
    await test.proxy.handle(request(path!, method!), response);
    expect(response.status).toBe(404);
  }
  const response = new Response();
  await test.proxy.handle(request(), response);
  expect(test.sent).toEqual([
    {
      type: "request",
      id: test.id(),
      method: "GET",
      path: "/api/guest/session?share=share_001",
      headers: { cookie: "mines_guest_share_001=guest-token", "content-type": "application/json" },
      ipAddress: "192.0.2.10",
    },
  ]);
  test.host.disconnect();
});

it("rewrites only guest cookie paths while retaining dynamic expiry and streams with drain acknowledgments", async () => {
  const test = fixture();
  const response = new Response();
  await test.proxy.handle(request(), response);
  test.host.receive({
    type: "head",
    id: test.id(),
    status: 200,
    headers: { "content-type": "text/event-stream", connection: "keep-alive" },
    cookies: [
      "mines_guest_share_001=token; Path=/api/guest; Max-Age=123; HttpOnly; Secure; SameSite=Strict",
      "account=private; Path=/api/guest",
    ],
  });
  expect(response.headers).toMatchObject({
    "content-type": "text/event-stream",
    "set-cookie": [
      `mines_guest_share_001=token; Path=${base}; Max-Age=123; HttpOnly; Secure; SameSite=Strict`,
    ],
  });
  expect(response.headers).not.toHaveProperty("connection");
  response.writable = false;
  test.host.receive({
    type: "chunk",
    id: test.id(),
    body: Buffer.from("data: ok\n\n").toString("base64"),
  });
  expect(test.sent).toHaveLength(1);
  response.emit("drain");
  expect(test.sent.at(-1)).toEqual({ type: "ack", id: test.id() });
  test.host.receive({ type: "end", id: test.id() });
  expect(response.writableEnded).toBe(true);
  expect(Buffer.concat(response.chunks).toString()).toBe("data: ok\n\n");
});

it("caps pending requests per host, cancels aborted HTTP and frees capacity", async () => {
  const test = fixture();
  const first = request();
  await test.proxy.handle(first, new Response());
  for (let i = 1; i < GUEST_PROXY_MAX_PENDING; i++)
    await test.proxy.handle(request(), new Response());
  const denied = new Response();
  await test.proxy.handle(request(), denied);
  expect(denied.status).toBe(429);
  first.emit("aborted");
  expect(test.sent.at(-1)).toEqual({ type: "cancel", id: test.id() });
  const admitted = new Response();
  await test.proxy.handle(request(), admitted);
  expect(test.sent.filter((frame) => frame.type === "request")).toHaveLength(
    GUEST_PROXY_MAX_PENDING + 1,
  );
  test.host.disconnect();
  expect(admitted.status).toBe(503);
});

it("admits nickname redemption and uploads alongside one hundred open guest streams", async () => {
  const test = fixture();
  for (let i = 0; i < 100; i++) {
    await test.proxy.handle(request(`${base}/stream?share=share_001`), new Response());
    test.host.receive({
      type: "head",
      id: test.id(i),
      status: 200,
      headers: { "content-type": "text/event-stream" },
      cookies: [],
    });
  }
  const redeem = new Response();
  await test.proxy.handle(request(`${base}/redeem`, "POST", '{"nickname":"Guest"}'), redeem);
  const upload = new Response();
  await test.proxy.handle(request(`${base}/messages`, "POST", "file-data"), upload);
  expect(test.sent.filter((frame) => frame.type === "request")).toHaveLength(102);
  expect(test.sent.at(-1)).toMatchObject({
    method: "POST",
    path: "/api/guest/messages",
    body: Buffer.from("file-data").toString("base64"),
  });
  expect(redeem.status).toBe(0);
  expect(upload.status).toBe(0);
  test.host.disconnect();
});

it("sandbox-protects malicious host HTML, forbids redirects and forces no caching", async () => {
  const test = fixture();
  const response = new Response();
  await test.proxy.handle(request(`${base}/render?share=share_001`), response);
  test.host.receive({
    type: "head",
    id: test.id(),
    status: 302,
    headers: {
      "content-type": "text/html",
      "content-security-policy": "sandbox allow-scripts allow-same-origin; default-src *",
      "cache-control": "public, max-age=31536000",
      "x-content-type-options": "",
      location: "https://attacker.example",
    },
    cookies: [
      "mines_guest_share_001=token; Domain=.gemstud.io; Path=/api/guest; Max-Age=3; Secure; HttpOnly; SameSite=Strict",
      "account=stolen; Path=/api/guest",
    ],
  });
  expect(response.headers).toMatchObject({
    "content-security-policy":
      "sandbox allow-scripts allow-same-origin; default-src *, sandbox allow-scripts allow-forms allow-popups allow-downloads",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store, no-transform",
    "set-cookie": [
      `mines_guest_share_001=token; Path=${base}; Max-Age=3; Secure; HttpOnly; SameSite=Strict`,
    ],
  });
  expect(response.headers).not.toHaveProperty("location");
  test.host.disconnect();
});

it("ACKs immediate writes once and drops drain ACKs after cancellation", async () => {
  const test = fixture();
  const response = new Response();
  await test.proxy.handle(request(), response);
  test.host.receive({ type: "head", id: test.id(), status: 200, headers: {}, cookies: [] });
  test.host.receive({ type: "chunk", id: test.id(), body: "YQ==" });
  expect(test.sent.at(-1)).toEqual({ type: "ack", id: test.id() });
  response.writable = false;
  test.host.receive({ type: "chunk", id: test.id(), body: "Yg==" });
  response.emit("close");
  const count = test.sent.length;
  response.emit("drain");
  expect(test.sent).toHaveLength(count);
  expect(test.sent.at(-1)).toEqual({ type: "cancel", id: test.id() });
  test.host.disconnect();
});

it("expires unanswered heads and preserves a replacement when the old host disconnects", async () => {
  const test = fixture();
  const response = new Response();
  await test.proxy.handle(request(), response);
  test.proxy.pulse();
  test.proxy.pulse();
  expect(response.status).toBe(504);
  expect(test.sent.at(-1)).toEqual({ type: "cancel", id: test.id() });
  const sent: Array<GuestProxyControlFrame> = [];
  const replacement = test.proxy.connect(deviceId, {
    send: (frame) => sent.push(frame),
    close: () => {},
  });
  test.host.disconnect();
  await test.proxy.handle(request(), new Response());
  expect(sent.at(-1)).toMatchObject({ type: "request" });
  replacement.disconnect();
});

it("rejects oversized declared and streamed bodies without forwarding them", async () => {
  const test = fixture();
  const response = new Response();
  const input = request(`${base}/messages`, "POST", "a");
  Object.assign(input.headers, { "content-length": String(10 * 1024 * 1024 + 65537) });
  await test.proxy.handle(input, response);
  expect(response.status).toBe(413);
  const streamed = new Response();
  await test.proxy.handle(
    request(`${base}/messages`, "POST", "a".repeat(10 * 1024 * 1024 + 65537)),
    streamed,
  );
  expect(streamed.status).toBe(413);
  expect(test.sent).toEqual([]);
  test.host.disconnect();
});

it("rejects chunks before headers and over 48KiB, and replaces disconnected hosts safely", async () => {
  const test = fixture();
  const response = new Response();
  await test.proxy.handle(request(), response);
  test.host.receive({ type: "chunk", id: test.id(), body: "YQ==" });
  expect(test.closed()).toBe(true);
  expect(response.status).toBe(502);
  const second = fixture();
  const next = new Response();
  await second.proxy.handle(request(), next);
  second.host.receive({ type: "head", id: second.id(), status: 200, headers: {}, cookies: [] });
  second.host.receive({
    type: "chunk",
    id: second.id(),
    body: Buffer.alloc(48 * 1024 + 1).toString("base64"),
  });
  expect(next.destroyed).toBe(true);
  expect(second.closed()).toBe(true);
});
