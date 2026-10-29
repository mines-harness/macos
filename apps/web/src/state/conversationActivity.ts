import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const guestSharePublishActivity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:guest-share:activity:publish",
  tag: WS_METHODS.guestSharePublishActivity,
});

export const guestShareActivitySubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mines:guest-share:activity:subscribe",
    tag: WS_METHODS.guestShareActivitySubscribe,
    idleTtlMs: 0,
  },
);
