import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DesktopMinesAccountStore } from "../../app/DesktopMinesAccountStore.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const getMinesAccountToken = DesktopIpc.makeIpcMethod({
  channel: Channels.GET_MINES_ACCOUNT_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.minesAccount.get")(function* () {
    return yield* (yield* DesktopMinesAccountStore).get;
  }),
});

export const setMinesAccountToken = DesktopIpc.makeIpcMethod({
  channel: Channels.SET_MINES_ACCOUNT_TOKEN_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.minesAccount.set")(function* (token) {
    yield* (yield* DesktopMinesAccountStore).set(token);
  }),
});
