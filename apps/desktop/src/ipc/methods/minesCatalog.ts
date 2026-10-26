import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopMinesCatalogStore } from "../../app/DesktopMinesCatalogStore.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const getMinesCatalog = DesktopIpc.makeIpcMethod({
  channel: Channels.GET_MINES_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.minesCatalog.get")(function* (accountId) {
    return yield* (yield* DesktopMinesCatalogStore).get(accountId);
  }),
});
export const setMinesCatalog = DesktopIpc.makeIpcMethod({
  channel: Channels.SET_MINES_CATALOG_CHANNEL,
  payload: Schema.Struct({
    accountId: Schema.String,
    snapshot: Schema.String,
    mergeCatalog: Schema.optional(Schema.Boolean),
  }),
  // Void encodes any input as undefined, so preserve snapshots before matching it.
  result: Schema.Union([Schema.String, Schema.Void]),
  handler: Effect.fn("desktop.ipc.minesCatalog.set")(function* ({
    accountId,
    snapshot,
    mergeCatalog,
  }) {
    return yield* (yield* DesktopMinesCatalogStore).set(accountId, snapshot, mergeCatalog);
  }),
});
export const clearMinesCatalog = DesktopIpc.makeIpcMethod({
  channel: Channels.CLEAR_MINES_CATALOG_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.minesCatalog.clear")(function* (accountId) {
    yield* (yield* DesktopMinesCatalogStore).clear(accountId);
  }),
});
