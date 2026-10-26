import * as Effect from "effect/Effect";
import type * as Client from "./client.ts";

export const start = Effect.fn("CodexAppServerRealtime.start")(
  (
    client: Client.CodexAppServerClient["Service"],
    input: { readonly threadId: string; readonly sdp: string },
  ) =>
    client.raw
      .request("thread/realtime/start", {
        threadId: input.threadId,
        outputModality: "audio",
        transport: { type: "webrtc", sdp: input.sdp },
      })
      .pipe(Effect.asVoid),
);

export const stop = Effect.fn("CodexAppServerRealtime.stop")(
  (client: Client.CodexAppServerClient["Service"], input: { readonly threadId: string }) =>
    client.raw.request("thread/realtime/stop", { threadId: input.threadId }).pipe(Effect.asVoid),
);
