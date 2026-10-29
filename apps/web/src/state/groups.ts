import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const groupList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:list",
  tag: WS_METHODS.groupsList,
  staleTimeMs: 10_000,
  idleTtlMs: 60_000,
});
export const groupSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:subscribe",
  tag: WS_METHODS.groupsSubscribe,
  idleTtlMs: 0,
});
export const groupCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:create",
  tag: WS_METHODS.groupsCreate,
});
export const groupAddMembers = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:add-members",
  tag: WS_METHODS.groupsAddMembers,
});
export const groupSend = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:send",
  tag: WS_METHODS.groupsSend,
});
export const groupStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:stop",
  tag: WS_METHODS.groupsStop,
});
export const groupArchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:archive",
  tag: WS_METHODS.groupsArchive,
});
export const groupRetry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:retry",
  tag: WS_METHODS.groupsRetry,
});

export const groupLaunchThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:launch-thread",
  tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
});

export const groupRunPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:run-page",
  tag: WS_METHODS.groupsGetRunPage,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export const groupRunItem = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:run-item",
  tag: WS_METHODS.groupsGetRunItem,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: (target) =>
    groupSubscription({
      environmentId: target.environmentId,
      input: { groupId: target.input.groupId },
    }),
});
export const groupRunBodyRange = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:run-body",
  tag: WS_METHODS.groupsGetRunBodyRange,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const groupRunAsset = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:groups:run-asset",
  tag: WS_METHODS.groupsGetRunAsset,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const groupRespondToRuntimeRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:groups:respond-runtime-request",
  tag: WS_METHODS.groupsRespondToRuntimeRequest,
});
