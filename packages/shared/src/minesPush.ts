import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PeerIdentity } from "./minesPeerTrust.ts";
import { stableStringify } from "./relaySigning.ts";

const OpaqueId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/));
const EventId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export const MinesPushKind = Schema.Literals(["run-completed", "needs-attention"]);
export type MinesPushKind = typeof MinesPushKind.Type;
export const MinesPushPayload = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("register"),
    token: Schema.String.check(
      Schema.isPattern(/^(ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]{10,200}\]$/),
    ),
  }),
  Schema.Struct({ action: Schema.Literal("remove") }),
  Schema.Struct({ action: Schema.Literal("alert"), eventId: EventId, kind: MinesPushKind }),
]);
export type MinesPushPayload = typeof MinesPushPayload.Type;
export const MinesPushRequest = Schema.Struct({
  version: Schema.Literal(1),
  purpose: Schema.Literal("mines-generic-push-v1"),
  deviceId: OpaqueId,
  publicKey: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
  issuedAt: Schema.Int,
  nonce: OpaqueId,
  payload: MinesPushPayload,
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
});
export type MinesPushRequest = typeof MinesPushRequest.Type;
export class MinesPushError extends Schema.TaggedError<MinesPushError>()("MinesPushError", {
  code: Schema.Literals([
    "disabled",
    "invalid-request",
    "unauthorized",
    "replayed",
    "rate-limited",
    "unavailable",
  ]),
}) {
  override get message() {
    return `mines notifications: ${this.code}`;
  }
}

const isMinesPushError = Schema.is(MinesPushError);
// Reject unknown properties instead of stripping them: no title, text, or thread payload may enter the service.
const decode = Schema.decodeUnknownSync(MinesPushRequest, { onExcessProperty: "error" });
const encoder = new TextEncoder();
export function signMinesPushRequest(
  identity: PeerIdentity,
  payload: MinesPushPayload,
  nonce: string,
  issuedAt: number,
): MinesPushRequest {
  const unsigned = {
    version: 1 as const,
    purpose: "mines-generic-push-v1" as const,
    deviceId: identity.device.deviceId,
    publicKey: identity.device.publicKey,
    issuedAt,
    nonce,
    payload,
  };
  return decode({
    ...unsigned,
    signature: Base64Url.encode(
      ed25519.sign(encoder.encode(stableStringify(unsigned)), identity.privateKey),
    ),
  });
}
export function verifyMinesPushRequest(value: unknown, now: number): MinesPushRequest {
  try {
    const request = decode(value);
    if (request.issuedAt > now + 15 || request.issuedAt < now - 60)
      throw new MinesPushError({ code: "invalid-request" });
    const { signature, ...unsigned } = request;
    const key = Result.getOrThrow(Base64Url.decode(request.publicKey));
    if (
      Base64Url.encode(sha256(key)) !== request.deviceId ||
      !ed25519.verify(
        Result.getOrThrow(Base64Url.decode(signature)),
        encoder.encode(stableStringify(unsigned)),
        key,
      )
    )
      throw new MinesPushError({ code: "unauthorized" });
    return request;
  } catch (cause) {
    throw isMinesPushError(cause) ? cause : new MinesPushError({ code: "invalid-request" });
  }
}

function endpoint(base: string, path: string) {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new MinesPushError({ code: "invalid-request" });
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}
const Capability = Schema.Struct({
  enabled: Schema.Boolean,
  transport: Schema.NullOr(Schema.Literal("expo")),
});
const decodeCapability = Schema.decodeUnknownSync(Capability);
const decodeAccepted = Schema.decodeUnknownSync(
  Schema.Struct({ accepted: Schema.Int, delivered: Schema.Literal(false) }),
);
export async function minesPushCapability(
  controlUrl: string,
  bearer: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(endpoint(controlUrl, "/v1/push/capability"), {
    headers: { authorization: `Bearer ${bearer}` },
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new MinesPushError({ code: "unavailable" });
  return decodeCapability(await response.json());
}
export async function sendMinesPushRequest(input: {
  controlUrl: string;
  request: MinesPushRequest;
  bearer?: string;
  fetch?: typeof fetch;
}) {
  const response = await (input.fetch ?? fetch)(
    endpoint(
      input.controlUrl,
      "/v1/push/" + (input.request.payload.action === "alert" ? "alerts" : "device"),
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
      },
      body: JSON.stringify(input.request),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new MinesPushError({
      code:
        response.status === 503
          ? "disabled"
          : response.status === 403
            ? "unauthorized"
            : "unavailable",
    });
  const body: unknown = await response.json();
  return decodeAccepted(body);
}

export function genericMinesPushMessage(
  token: string,
  event: { eventId: string; kind: MinesPushKind },
) {
  return {
    to: token,
    title: "mines",
    body:
      event.kind === "run-completed"
        ? "An agent turn finished. Open mines to see the result."
        : "An agent needs your attention. Open mines to continue.",
    sound: "default",
    ttl: 3600,
    channelId: "mines-agents",
    data: { minesEventId: event.eventId, kind: event.kind },
  };
}
