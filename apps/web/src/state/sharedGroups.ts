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

export const sharedGroupPublishActivity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:shared-groups:activity:publish",
  tag: WS_METHODS.sharedGroupsPublishActivity,
});

export const sharedGroupActivitySubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mines:shared-groups:activity:subscribe",
    tag: WS_METHODS.sharedGroupsActivitySubscribe,
    idleTtlMs: 0,
  },
);

export const sharedGroupRunPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:shared-groups:run-page",
  tag: WS_METHODS.sharedGroupsGetRunPage,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const sharedGroupRunItem = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:shared-groups:run-item",
  tag: WS_METHODS.sharedGroupsGetRunItem,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: (target) =>
    sharedGroupSubscription({
      environmentId: target.environmentId,
      input: {
        groupKey: target.input.groupKey,
        coordinatorDeviceId: target.input.coordinatorDeviceId,
      },
    }),
});
export const sharedGroupRunBodyRange = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:shared-groups:run-body",
  tag: WS_METHODS.sharedGroupsGetRunBodyRange,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const sharedGroupRunAsset = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:shared-groups:run-asset",
  tag: WS_METHODS.sharedGroupsGetRunAsset,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const sharedGroupRespondToRuntimeRequest = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "mines:shared-groups:respond-runtime-request",
    tag: WS_METHODS.sharedGroupsRespondToRuntimeRequest,
  },
);
