import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const groupMessageHistory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:message-history",
  tag: WS_METHODS.groupsGetHistory,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const sharedGroupMessageHistory = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "mines:shared-groups:message-history",
    tag: WS_METHODS.sharedGroupsGetHistory,
    staleTimeMs: 0,
    idleTtlMs: 0,
  },
);
export const groupMessageChunk = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:message-chunk",
  tag: WS_METHODS.groupsGetMessageChunk,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const sharedGroupMessageChunk = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:shared-groups:message-chunk",
  tag: WS_METHODS.sharedGroupsGetMessageChunk,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
