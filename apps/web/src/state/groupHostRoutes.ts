import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const groupHostRoutes = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:group-hosts",
  tag: WS_METHODS.groupsListHostRoutes,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});
export const readGroupHostRoutes = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:group-hosts:read",
  tag: WS_METHODS.groupsListHostRoutes,
});
export const connectGroupHost = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:group-host-connect",
  tag: WS_METHODS.groupsConnectHost,
});
export const disconnectGroupHost = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:group-host-disconnect",
  tag: WS_METHODS.groupsDisconnectHost,
});
