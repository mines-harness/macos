import * as Schema from "effect/Schema";

export const GUEST_PROXY_MAX_REQUEST_BYTES = 10 * 1024 * 1024 + 64 * 1024;
export const GUEST_PROXY_CHUNK_BYTES = 48 * 1024;
export const GUEST_PROXY_MAX_PENDING = 256;

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/));
const Headers = Schema.Record(
  Schema.String.check(Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(16_384)),
).check(Schema.makeFilter((value) => Object.keys(value).length <= 32));
const Base64 = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  Schema.makeFilter((value) => value.length % 4 === 0),
);

export const GuestProxyRequest = Schema.Struct({
  type: Schema.Literal("request"),
  id: Id,
  method: Schema.Literals(["GET", "POST", "PATCH", "DELETE"]),
  path: Schema.String.check(Schema.isMaxLength(4096)),
  headers: Headers,
  body: Schema.optionalKey(
    Base64.check(Schema.isMaxLength(Math.ceil(GUEST_PROXY_MAX_REQUEST_BYTES / 3) * 4)),
  ),
  ipAddress: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(64)),
});
export type GuestProxyRequest = typeof GuestProxyRequest.Type;

export const GuestProxyCancel = Schema.Struct({ type: Schema.Literal("cancel"), id: Id });
export const GuestProxyAck = Schema.Struct({ type: Schema.Literal("ack"), id: Id });
export const GuestProxyResponseHead = Schema.Struct({
  type: Schema.Literal("head"),
  id: Id,
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  headers: Headers,
  cookies: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(8)),
});
export const GuestProxyChunk = Schema.Struct({
  type: Schema.Literal("chunk"),
  id: Id,
  body: Base64.check(Schema.isMaxLength(Math.ceil(GUEST_PROXY_CHUNK_BYTES / 3) * 4)),
});
export const GuestProxyEnd = Schema.Struct({ type: Schema.Literal("end"), id: Id });
export const GuestProxyError = Schema.Struct({ type: Schema.Literal("error"), id: Id });
export const GuestProxyControlFrame = Schema.Union([
  GuestProxyRequest,
  GuestProxyCancel,
  GuestProxyAck,
]);
export type GuestProxyControlFrame = typeof GuestProxyControlFrame.Type;
export const GuestProxyHostFrame = Schema.Union([
  GuestProxyResponseHead,
  GuestProxyChunk,
  GuestProxyEnd,
  GuestProxyError,
]);
export type GuestProxyHostFrame = typeof GuestProxyHostFrame.Type;
