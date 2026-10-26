import { PeerError, PeerSignal, PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";
import { signPeerDeviceProof, type PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Schema from "effect/Schema";

export interface PeerSignalGateway {
  readonly send: (signal: PeerSignal) => Promise<void>;
  readonly subscribe: (listener: (signal: PeerSignal) => void) => () => void;
}

export interface DeviceSignalGateway extends PeerSignalGateway {
  readonly close: () => void;
  readonly closed: Promise<void>;
}

export interface PeerControlOptions {
  readonly controlUrl: string;
  readonly identity: PeerIdentity;
  readonly bearerToken?: () => Promise<string>;
  readonly randomId: () => string;
  readonly nowSeconds: () => number;
  readonly fetch?: typeof fetch;
  readonly createWebSocket?: (url: string) => WebSocket;
}

const decodeAccount = Schema.decodeUnknownSync(Schema.Struct({ accountId: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(
  Schema.Struct({ ticket: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)) }),
);
const isReady = Schema.is(Schema.Struct({ ready: Schema.Literal(true) }));
const decodeSignal = Schema.decodeUnknownSync(PeerSignal);
const decodeDirectory = Schema.decodeUnknownSync(PeerDeviceDirectory);

function controlUrl(base: string, path: string): URL {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new PeerError({ code: "direct-unavailable" });
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

async function request(
  input: Pick<PeerControlOptions, "controlUrl" | "bearerToken" | "fetch">,
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  maximumResponseLength = 32_768,
): Promise<unknown> {
  const response = await (input.fetch ?? globalThis.fetch)(controlUrl(input.controlUrl, path), {
    method,
    headers: {
      ...(input.bearerToken ? { authorization: `Bearer ${await input.bearerToken()}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) throw new PeerError({ code: "unapproved-device" });
  const text = await response.text();
  if (text.length > maximumResponseLength) throw new PeerError({ code: "frame-too-large" });
  return JSON.parse(text);
}

export async function registerPeerDevice(input: PeerControlOptions): Promise<string> {
  const response = await request(
    input,
    "/v1/devices",
    "POST",
    signPeerDeviceProof(input.identity, "register", input.randomId(), input.nowSeconds()),
  );
  return decodeAccount(response).accountId;
}

export async function getPeerAccount(
  input: Pick<PeerControlOptions, "controlUrl" | "bearerToken" | "fetch">,
): Promise<string> {
  return decodeAccount(await request(input, "/v1/account", "GET")).accountId;
}

export async function getPeerDevices(
  input: Pick<PeerControlOptions, "controlUrl" | "bearerToken" | "fetch">,
): Promise<PeerDeviceDirectory> {
  return decodeDirectory(await request(input, "/v1/devices", "GET", undefined, 65_536));
}

export async function openPeerSignalGateway(
  input: PeerControlOptions & { readonly signal: AbortSignal },
): Promise<DeviceSignalGateway> {
  const response = await request(
    input,
    "/v1/device-tickets",
    "POST",
    signPeerDeviceProof(input.identity, "ticket", input.randomId(), input.nowSeconds()),
  );
  const { ticket } = decodeTicket(response);
  if (input.signal.aborted) throw new PeerError({ code: "closed" });
  const url = controlUrl(input.controlUrl, "/v1/signals");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  const socket = (input.createWebSocket ?? ((value) => new WebSocket(value)))(url.toString());
  const listeners = new Set<(signal: PeerSignal) => void>();
  let finish!: () => void;
  let fail!: (error: PeerError) => void;
  let ready!: () => void;
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const close = () => {
    if (ended) return;
    ended = true;
    input.signal.removeEventListener("abort", close);
    socket.close();
    listeners.clear();
    fail(new PeerError({ code: "direct-unavailable" }));
    finish();
  };
  input.signal.addEventListener("abort", close, { once: true });
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  socket.addEventListener("message", (event) => {
    try {
      const data: unknown = event.data;
      if (typeof data !== "string" || data.length > 96 * 1024)
        throw new PeerError({ code: "invalid-description" });
      const value: unknown = JSON.parse(data);
      if (isReady(value)) {
        ready();
        return;
      }
      const signal = decodeSignal(value);
      for (const listener of listeners) listener(signal);
    } catch {
      close();
    }
  });
  await opened;
  return {
    close,
    closed,
    async send(signal) {
      if (ended || socket.readyState !== socket.OPEN || socket.bufferedAmount > 128 * 1024)
        throw new PeerError({ code: "direct-unavailable" });
      socket.send(JSON.stringify(signal));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
