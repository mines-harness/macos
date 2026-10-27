import { signPeerDeviceProof, type PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as HostSignalingService from "../peer/HostSignalingService.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { bindGuestProxyBridge } from "./GuestProxyBridge.ts";

export class GuestPublicEndpointError extends Schema.TaggedError<GuestPublicEndpointError>()(
  "GuestPublicEndpointError",
  {
    stage: Schema.Literals([
      "disabled",
      "unconfigured",
      "discovery",
      "identity",
      "ticket",
      "connection",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Public guest sharing is unavailable.";
  }
}

type PublicEndpoint = { readonly host: string; readonly url: (credential: string) => string };

export class GuestPublicEndpoint extends Context.Service<
  GuestPublicEndpoint,
  {
    readonly ensure: Effect.Effect<PublicEndpoint, GuestPublicEndpointError>;
    readonly current: Effect.Effect<PublicEndpoint | null>;
  }
>()("mines/guest/GuestPublicEndpoint") {}

const decodeConfig = Schema.decodeUnknownSync(Schema.Struct({ publicUrl: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(
  Schema.Struct({ ticket: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)) }),
);
const isReady = Schema.is(Schema.Struct({ ready: Schema.Literal(true) }));
const isGuestPublicEndpointError = Schema.is(GuestPublicEndpointError);

function endpointUrl(value: string, path?: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("An HTTPS endpoint is required");
  if (path !== undefined) {
    url.pathname = path;
    url.search = "";
    url.hash = "";
  } else if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("A public origin is required");
  }
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Guest control request rejected");
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) throw new Error("Guest control response is too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function discoverPublicOrigin(controlUrl: string, signal: AbortSignal): Promise<string> {
  // @effect-diagnostics-next-line globalFetch:off -- This native HTTP/WebSocket adapter shares the acquisition AbortSignal.
  const response = await fetch(endpointUrl(controlUrl, "/v1/guest-config"), {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    signal,
  });
  return endpointUrl(decodeConfig(await readJson(response)).publicUrl).origin;
}

async function openGuestHost(input: {
  readonly controlUrl: string;
  readonly publicUrl: string;
  readonly identity: PeerIdentity;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly port: number;
  readonly signal: AbortSignal;
}) {
  // @effect-diagnostics-next-line globalFetch:off -- The signed ticket request belongs to the abortable native WebSocket handshake.
  const response = await fetch(endpointUrl(input.controlUrl, "/v1/device-tickets"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      signPeerDeviceProof(input.identity, "ticket", input.nonce, input.issuedAt),
    ),
    redirect: "error",
    credentials: "omit",
    signal: input.signal,
  }).catch((cause: unknown) => {
    throw new GuestPublicEndpointError({ stage: "ticket", cause });
  });
  const { ticket } = await readJson(response)
    .then(decodeTicket)
    .catch((cause: unknown) => {
      throw new GuestPublicEndpointError({ stage: "ticket", cause });
    });
  if (input.signal.aborted) throw new GuestPublicEndpointError({ stage: "connection" });
  const url = endpointUrl(input.controlUrl, "/v1/guest-host");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  const socket = new WebSocket(url);
  let live = true;
  let unbind = () => {};
  let finish!: () => void;
  let fail!: (error: GuestPublicEndpointError) => void;
  let ready!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const close = () => {
    if (!live) return;
    live = false;
    input.signal.removeEventListener("abort", close);
    socket.removeEventListener("message", onMessage);
    unbind();
    socket.close();
    fail(new GuestPublicEndpointError({ stage: "connection" }));
    finish();
  };
  const onMessage = (event: MessageEvent) => {
    try {
      if (
        typeof event.data !== "string" ||
        event.data.length > 1024 ||
        !isReady(JSON.parse(event.data))
      )
        return close();
      socket.removeEventListener("message", onMessage);
      unbind = bindGuestProxyBridge(socket, input.port);
      ready();
    } catch {
      close();
    }
  };
  input.signal.addEventListener("abort", close, { once: true });
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  socket.addEventListener("message", onMessage);
  if (input.signal.aborted) close();
  await opened;
  const host = input.identity.device.deviceId;
  return {
    close,
    closed,
    get live() {
      return live;
    },
    endpoint: {
      host,
      url: (credential: string) => `${input.publicUrl}/guest?host=${host}#${credential}`,
    },
  };
}

const make = Effect.gen(function* () {
  const signaling = yield* HostSignalingService.HostSignalingService;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const server = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  let active: (Awaited<ReturnType<typeof openGuestHost>> & { readonly key: string }) | null = null;
  const clear = () => {
    active?.close();
    active = null;
  };
  yield* Effect.addFinalizer(() => Effect.sync(clear));
  const configured = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.guestSharingEnabled),
      Effect.mapError((cause) => new GuestPublicEndpointError({ stage: "disabled", cause })),
    );
    if (!enabled) return yield* new GuestPublicEndpointError({ stage: "disabled" });
    const state = yield* SubscriptionRef.get(signaling.state);
    if (!state.configured || !state.controlUrl || !state.accountId)
      return yield* new GuestPublicEndpointError({ stage: "unconfigured" });
    return { controlUrl: state.controlUrl, key: `${state.accountId}\n${state.controlUrl}` };
  });
  const reconcile = Effect.fn("GuestPublicEndpoint.ensure")(function* () {
    const config = yield* configured.pipe(Effect.tapError(() => Effect.sync(clear)));
    if (active?.live && active.key === config.key) return active.endpoint;
    clear();
    const identity = yield* trust.identity.pipe(
      Effect.mapError((cause) => new GuestPublicEndpointError({ stage: "identity", cause })),
    );
    const nonce = yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError((cause) => new GuestPublicEndpointError({ stage: "identity", cause })));
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const publicUrl = yield* Effect.tryPromise({
      try: (signal) => discoverPublicOrigin(config.controlUrl, signal),
      catch: (cause) => new GuestPublicEndpointError({ stage: "discovery", cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new GuestPublicEndpointError({ stage: "discovery" })),
      }),
    );
    const connection = yield* Effect.tryPromise({
      try: (signal) =>
        openGuestHost({
          ...config,
          publicUrl,
          identity,
          nonce,
          issuedAt,
          port: server.port,
          signal,
        }),
      catch: (cause) =>
        isGuestPublicEndpointError(cause)
          ? cause
          : new GuestPublicEndpointError({ stage: "connection", cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new GuestPublicEndpointError({ stage: "connection" })),
      }),
    );
    const latest = yield* configured.pipe(Effect.tapError(() => Effect.sync(connection.close)));
    if (latest.key !== config.key || !connection.live) {
      connection.close();
      return yield* new GuestPublicEndpointError({ stage: "connection" });
    }
    active = {
      ...connection,
      key: config.key,
      get live() {
        return connection.live;
      },
    };
    return connection.endpoint;
  }, lock.withPermit);
  const changes = yield* settings.subscribeChanges;
  yield* Stream.runForEach(Stream.merge(changes, SubscriptionRef.changes(signaling.state)), () =>
    reconcile().pipe(Effect.ignore),
  ).pipe(Effect.forkScoped);
  yield* reconcile().pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  );
  return GuestPublicEndpoint.of({
    ensure: reconcile(),
    current: Effect.gen(function* () {
      const config = yield* configured;
      return active?.live && active.key === config.key ? active.endpoint : null;
    }).pipe(Effect.orElseSucceed(() => null)),
  });
});

export const layer = Layer.effect(GuestPublicEndpoint, make);
