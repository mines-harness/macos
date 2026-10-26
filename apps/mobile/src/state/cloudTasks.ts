import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const cloudSnapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:cloud:snapshot",
  tag: WS_METHODS.cloudSnapshot,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});
export const cloudRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:refresh",
  tag: WS_METHODS.cloudRefresh,
});
export const cloudSubmit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:submit",
  tag: WS_METHODS.cloudSubmit,
});
export const cloudLink = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:link",
  tag: WS_METHODS.cloudLink,
});
export const cloudFollowUp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:follow-up",
  tag: WS_METHODS.cloudFollowUp,
});
export const cloudStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:status",
  tag: WS_METHODS.cloudStatus,
});
export const cloudDiff = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:diff",
  tag: WS_METHODS.cloudDiff,
});
export const cloudApply = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:apply",
  tag: WS_METHODS.cloudApply,
});
export const cloudUnlink = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:cloud:unlink",
  tag: WS_METHODS.cloudUnlink,
});
