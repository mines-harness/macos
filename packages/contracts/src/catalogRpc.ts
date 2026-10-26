import * as Schema from "effect/Schema";

const AccountId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const EncodedUpdate = Schema.String.check(
  Schema.isMaxLength(12 * 1024 * 1024),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
);
export const CatalogContextRevision = Schema.Struct({
  accountId: AccountId,
  stateVector: Schema.String.check(
    Schema.isMaxLength(64 * 1024),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export type CatalogContextRevision = typeof CatalogContextRevision.Type;
export const CatalogBindIdentityInput = Schema.Struct({
  bearerToken: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  ),
});
export type CatalogBindIdentityInput = typeof CatalogBindIdentityInput.Type;
export const CatalogBindIdentityResult = Schema.Struct({ accountId: Schema.NullOr(AccountId) });
export const CatalogExchangeInput = Schema.Struct({
  accountId: AccountId,
  stateVector: EncodedUpdate,
  update: Schema.optionalKey(EncodedUpdate),
});
export type CatalogExchangeInput = typeof CatalogExchangeInput.Type;
export const CatalogExchangeResult = Schema.Struct({
  update: EncodedUpdate,
  stateVector: EncodedUpdate,
});
export const CatalogSubscribeInput = Schema.Struct({ accountId: AccountId });
export const CatalogUpdate = EncodedUpdate;
export class CatalogRpcError extends Schema.TaggedError<CatalogRpcError>()("CatalogRpcError", {
  message: Schema.String,
}) {}
