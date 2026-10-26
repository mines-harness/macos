import { PeerError } from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class PeerConnections extends Context.Service<
  PeerConnections,
  {
    readonly register: (
      deviceId: string,
      connect: Effect.Effect<PeerSession, PeerError>,
    ) => Effect.Effect<() => void>;
    readonly connect: (deviceId: string) => Effect.Effect<PeerSession, PeerError>;
    readonly clear: Effect.Effect<void>;
    readonly subscribeSessions: (listener: (session: PeerSession) => void) => () => void;
  }
>()("@t3tools/client-runtime/peer/connections/PeerConnections") {}

export const layer = Layer.effect(
  PeerConnections,
  Effect.gen(function* () {
    const routes = new Map<string, Effect.Effect<PeerSession, PeerError>>();
    const active = new Set<PeerSession>();
    const listeners = new Set<(session: PeerSession) => void>();
    const clear = Effect.sync(() => {
      routes.clear();
      for (const session of active) session.close();
      active.clear();
    });
    yield* Effect.addFinalizer(() => clear);
    return PeerConnections.of({
      clear,
      subscribeSessions(listener) {
        listeners.add(listener);
        for (const session of active) listener(session);
        return () => {
          listeners.delete(listener);
        };
      },
      register: Effect.fn("PeerConnections.register")((id, connect) =>
        Effect.sync(() => {
          routes.set(id, connect);
          return () => {
            if (routes.get(id) === connect) {
              routes.delete(id);
              for (const session of active) if (session.remoteDeviceId === id) session.close();
            }
          };
        }),
      ),
      connect: Effect.fn("PeerConnections.connect")(function* (id) {
        const connect = routes.get(id);
        if (!connect) return yield* new PeerError({ code: "direct-unavailable" });
        const session = yield* connect;
        if (session.remoteDeviceId !== id || routes.get(id) !== connect) {
          session.close();
          return yield* new PeerError({ code: "unapproved-device" });
        }
        active.add(session);
        for (const listener of listeners) listener(session);
        void session.closed.then(() => active.delete(session));
        return session;
      }),
    });
  }),
);
