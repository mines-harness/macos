import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type ConversationActivityKind } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { AppState } from "react-native";
import { connectionAtomRuntime } from "../connection/runtime";
import { createConversationActivityPublisher } from "../lib/conversationActivityPublisher";

export const guestSharePublishActivity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:guest-share:publish-activity",
  tag: WS_METHODS.guestSharePublishActivity,
});

export const guestShareActivitySubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:guest-share:activity",
    tag: WS_METHODS.guestShareActivitySubscribe,
    idleTtlMs: 0,
  },
);

export const sharedGroupPublishActivity = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:publish-activity",
  tag: WS_METHODS.sharedGroupsPublishActivity,
});

export const sharedGroupActivitySubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:shared-groups:activity",
    tag: WS_METHODS.sharedGroupsActivitySubscribe,
    idleTtlMs: 0,
  },
);

export function useConversationActivityPublisher(input: {
  readonly scopeKey: string;
  readonly publish: (kind: ConversationActivityKind) => void;
  readonly enabled: boolean;
  readonly captureActive: boolean;
}) {
  const publisher = useRef<ReturnType<typeof createConversationActivityPublisher> | null>(null);
  const readPublish = useEffectEvent(() => input.publish);
  const readCapture = useEffectEvent(() => input.captureActive);
  // oxlint-disable-next-line mines/react-effect-budget -- Presence owns refresh timers and must send idle when its conversation closes or the app backgrounds.
  useEffect(() => {
    if (!input.enabled || !input.scopeKey) return;
    const controller = createConversationActivityPublisher(readPublish());
    publisher.current = controller;
    controller.setCaptureActive(readCapture());
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") controller.onBlur();
    });
    return () => {
      listener.remove();
      controller[Symbol.dispose]();
      publisher.current = null;
    };
  }, [input.enabled, input.scopeKey]);
  // oxlint-disable-next-line mines/react-effect-budget -- Voice presence follows the recorder's actual capture state, including permission rejection and stop.
  useEffect(() => publisher.current?.setCaptureActive(input.captureActive), [input.captureActive]);
  return {
    onEdit: (hasText = true) => publisher.current?.onEdit(hasText),
    onBlur: () => publisher.current?.onBlur(),
    onSubmit: () => publisher.current?.onSubmit(),
  };
}
