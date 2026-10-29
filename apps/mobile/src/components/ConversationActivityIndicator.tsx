import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { activeConversationActivity, type ConversationActivity } from "@t3tools/contracts";
import { AppText as Text } from "./ui/AppText";

export type NamedConversationActivity = ConversationActivity & {
  readonly name: string;
  readonly id?: string;
};

function ActivityMark({ voice }: { readonly voice: boolean }) {
  const reducedMotion = useReducedMotion();
  const phase = useSharedValue(0);
  // oxlint-disable-next-line mines/react-effect-budget -- The requested activity animation exists only while remote typing or recording is live and respects Reduced Motion.
  useEffect(() => {
    if (!reducedMotion) phase.set(withRepeat(withTiming(1, { duration: 600 }), -1, true));
    return () => cancelAnimation(phase);
  }, [phase, reducedMotion]);
  const first = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 0.7 : 0.35 + phase.value * 0.65,
    transform: [{ scaleY: voice ? (reducedMotion ? 0.8 : 0.4 + phase.value * 0.6) : 1 }],
  }));
  const second = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 0.7 : 1 - phase.value * 0.65,
    transform: [{ scaleY: voice ? (reducedMotion ? 1 : 1 - phase.value * 0.6) : 1 }],
  }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-0.5"
      style={{ width: 20, height: 16 }}
    >
      <Animated.View
        className="rounded-full bg-foreground-muted"
        style={[{ width: voice ? 3 : 4, height: voice ? 9 : 4 }, first]}
      />
      <Animated.View
        className="rounded-full bg-foreground-muted"
        style={[{ width: voice ? 3 : 4, height: voice ? 14 : 4 }, second]}
      />
      <Animated.View
        className="rounded-full bg-foreground-muted"
        style={[{ width: voice ? 3 : 4, height: voice ? 11 : 4 }, first]}
      />
    </View>
  );
}

export function ConversationActivityIndicator({
  activities,
  idleName,
}: {
  readonly activities: readonly NamedConversationActivity[];
  readonly idleName?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const deadlines = activities
    .filter((activity) => activity.kind !== "idle")
    .map((activity) => Date.parse(activity.expiresAt))
    .filter((deadline) => deadline > now);
  const expiresAt = deadlines.length ? Math.min(...deadlines) : null;
  // oxlint-disable-next-line mines/react-effect-budget -- One expiry timer removes abandoned remote presence without polling or leaving an animation running.
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const active = activities.filter(
    (activity) => activeConversationActivity(activity, now) !== "idle",
  );
  if (!active.length)
    return idleName ? (
      <Text className="text-sm font-mines-medium" numberOfLines={1}>
        {idleName}
      </Text>
    ) : null;
  return (
    <View className={idleName ? "gap-1" : "gap-1 px-4 py-1"} accessibilityLiveRegion="polite">
      {active.map((activity, index) => (
        <View
          key={activity.id ?? `${activity.name}:${index}`}
          className="flex-row items-center gap-2"
        >
          <ActivityMark voice={activity.kind === "voice"} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            <Text className="font-mines-bold">{activity.name}</Text>{" "}
            {activity.kind === "voice" ? "is singing..." : "is typing..."}
          </Text>
        </View>
      ))}
    </View>
  );
}
