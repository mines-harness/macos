import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const bindCatalogIdentity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:catalog:bind-identity",
  tag: WS_METHODS.catalogBindIdentity,
});
