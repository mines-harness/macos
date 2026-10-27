import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { AuthAccessReadScope, sessionGrantsScope, type EnvironmentId } from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { peerDeviceAccountIdAtom } from "./catalogIdentity";
import { peerIdentityState } from "./peers";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";

interface PeerDevicesSnapshot {
  readonly accountId: string | null;
  readonly routes: ReadonlyMap<EnvironmentId, string>;
  readonly devices: ReadonlyMap<EnvironmentId, PeerDevice>;
}

function connectionIdentity(entry: ConnectionCatalogEntry) {
  return JSON.stringify(
    connectionRoutes(entry)
      .map(({ target, profile }) => {
        const saved = Option.getOrNull(profile);
        switch (target._tag) {
          case "SshConnectionTarget": {
            const host = saved?._tag === "SshConnectionProfile" ? saved.target : null;
            return JSON.stringify([
              target._tag,
              target.connectionId,
              host && [host.alias, host.hostname, host.username, host.port],
            ]);
          }
          case "BearerConnectionTarget":
            return JSON.stringify([
              target._tag,
              target.connectionId,
              saved?._tag === "BearerConnectionProfile"
                ? [saved.httpBaseUrl, saved.wsBaseUrl, saved.peerDeviceId]
                : null,
            ]);
          case "PrimaryConnectionTarget":
            return JSON.stringify([target._tag, target.httpBaseUrl, target.wsBaseUrl]);
          case "RelayConnectionTarget":
            return JSON.stringify([target._tag]);
        }
      })
      .sort(),
  );
}

const snapshotAtom = Atom.make((get): PeerDevicesSnapshot => {
  const accountId = get(peerDeviceAccountIdAtom);
  const boundAccountId = get(minesAccountIdAtom);
  const previous = Option.getOrNull(get.self<PeerDevicesSnapshot>());
  const cached = previous?.accountId === accountId ? previous : null;
  const routes = new Map<EnvironmentId, string>();
  const devices = new Map<EnvironmentId, PeerDevice>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (accountId === null) continue;
    const routeKey = connectionIdentity(presentation.entry);
    routes.set(environmentId, routeKey);
    const retained =
      cached?.routes.get(environmentId) === routeKey ? cached.devices.get(environmentId) : null;
    const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
    const session = Option.getOrNull(AsyncResult.value(sessionResult));
    if (
      sessionResult._tag === "Success" &&
      !sessionGrantsScope(sessionResult.value, AuthAccessReadScope)
    )
      continue;
    if (
      presentation.connection.phase !== "connected" ||
      boundAccountId !== accountId ||
      sessionResult._tag !== "Success" ||
      session === null
    ) {
      if (retained) devices.set(environmentId, retained);
      continue;
    }
    const result = get(
      peerIdentityState(JSON.stringify([accountId, environmentId, routeKey]))({
        environmentId,
        input: {},
      }),
    );
    const device = (result._tag === "Success" ? result.value.device : null) ?? retained;
    if (device) devices.set(environmentId, device);
  }
  return {
    accountId,
    routes,
    devices:
      cached !== null &&
      cached.devices.size === devices.size &&
      [...devices].every(([id, device]) => cached.devices.get(id) === device)
        ? cached.devices
        : devices,
  };
}).pipe(Atom.keepAlive, Atom.withLabel("web-environment-peer-devices-snapshot"));

export const environmentPeerDevicesAtom = Atom.make((get) => get(snapshotAtom).devices).pipe(
  Atom.withLabel("web-environment-peer-devices"),
);
