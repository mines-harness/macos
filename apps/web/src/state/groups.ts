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
