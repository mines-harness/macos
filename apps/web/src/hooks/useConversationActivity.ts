import { type ConversationActivity, type ConversationActivityKind } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { createConversationActivityPublisher } from "./conversationActivityPublisher";
import { useStableCallback } from "./useStableCallback";
import { useDeadlinePassed } from "./useDeadline";

export function useConversationActivityPublisher({
  targetKey,
  publish,
  enabled = true,
}: {
  readonly targetKey: string;
  readonly publish: (kind: ConversationActivityKind) => unknown;
  readonly enabled?: boolean;
}) {
  const controller = useRef<ReturnType<typeof createConversationActivityPublisher> | null>(null);
  const createPublisher = useStableCallback(() => createConversationActivityPublisher(publish));
  // oxlint-disable-next-line mines/react-effect-budget -- owns remote presence leases and visibility listeners for one conversation
  useEffect(() => {
    if (!enabled || targetKey === "") return;
    const current = createPublisher();
    controller.current = current;
    const blur = () => current.clear();
    const hide = () => {
      if (document.visibilityState === "hidden") current.clear();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hide);
    return () => {
      current[Symbol.dispose]();
      if (controller.current === current) controller.current = null;
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [createPublisher, enabled, targetKey]);
  return {
    typing: useStableCallback(() => controller.current?.typing()),
    voice: useStableCallback((active: boolean) => controller.current?.voice(active)),
    clear: useStableCallback(() => controller.current?.clear()),
  };
}

export function useActiveConversationActivity(activity: ConversationActivity | null | undefined) {
  const expired = useDeadlinePassed(
    activity && activity.kind !== "idle" ? Date.parse(activity.expiresAt) : null,
  );
  return !activity || expired ? "idle" : activity.kind;
}
