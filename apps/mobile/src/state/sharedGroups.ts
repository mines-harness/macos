import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const sharedGroupSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:shared-groups:subscribe",
    tag: WS_METHODS.sharedGroupsSubscribe,
    idleTtlMs: 0,
  },
);
export const sharedGroupSend = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:send",
  tag: WS_METHODS.sharedGroupsSend,
});
export const sharedGroupAddChats = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:add-chats",
  tag: WS_METHODS.sharedGroupsAddChats,
});
export const sharedGroupRemoveChats = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:remove-chats",
  tag: WS_METHODS.sharedGroupsRemoveChats,
});
export const sharedGroupLeave = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:leave",
  tag: WS_METHODS.sharedGroupsLeave,
});
export const sharedGroupCoordinator = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:coordinator",
  tag: WS_METHODS.peerGetState,
});
export const sharedGroupAccountState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:account",
  tag: WS_METHODS.peerConnectionState,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
