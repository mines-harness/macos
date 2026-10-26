import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const sharedGroupSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mines:shared-groups:subscribe",
    tag: WS_METHODS.sharedGroupsSubscribe,
    idleTtlMs: 15_000,
  },
);
export const sharedGroupSend = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:shared-groups:send",
  tag: WS_METHODS.sharedGroupsSend,
});
export const sharedGroupAddChats = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:shared-groups:add-chats",
  tag: WS_METHODS.sharedGroupsAddChats,
});
export const sharedGroupRemoveChats = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:shared-groups:remove-chats",
  tag: WS_METHODS.sharedGroupsRemoveChats,
});
export const sharedGroupLeave = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:shared-groups:leave",
  tag: WS_METHODS.sharedGroupsLeave,
});
