import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const peerDeviceAccountIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-peer-device-account-id"),
);

export const bindCatalogIdentity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:catalog:bind-identity",
  tag: WS_METHODS.catalogBindIdentity,
});
