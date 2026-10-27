import { useAtomValue } from "@effect/atom-react";
import {
  CODEX_RESETS_URL,
  codexResetStatusAtom,
  describeCodexResetForecast,
} from "@t3tools/client-runtime/state/codex-resets";
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

function formatResetTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CodexResetStatus() {
  const result = useAtomValue(codexResetStatusAtom);
  const status = result._tag === "Success" ? result.value : null;
  const [clock, setClock] = useState(() => Date.now());
  const now = Math.max(clock, result._tag === "Success" ? result.timestamp : 0);
  const watchExpiresAt = status?.data.active_watch?.expires_at;
  const scheduledFor = status?.data.scheduled_reset?.scheduled_for;
  const nextBoundary = Math.min(
    ...[watchExpiresAt, scheduledFor].flatMap((value) => {
      const timestamp = value ? Date.parse(value) : 0;
      return timestamp > now ? [timestamp] : [];
    }),
  );

  useEffect(() => {
    if (!Number.isFinite(nextBoundary)) return;
    const timeout = setTimeout(
      () => setClock(Date.now()),
      Math.min(Math.max(0, nextBoundary - Date.now()) + 1, 2_147_483_647),
    );
    return () => clearTimeout(timeout);
  }, [nextBoundary]);

  const forecast = status
    ? describeCodexResetForecast(status, now)
    : result._tag === "Failure"
      ? "Reset data unavailable"
      : "Checking reset status…";
  const upcomingSchedule = scheduledFor && Date.parse(scheduledFor) > now ? scheduledFor : null;
  const latestReset = status?.data.latest_reset;

  return (
    <View className="gap-0.5 pt-2">
      <Text className="text-2xs text-foreground-muted">
        {forecast}
        {upcomingSchedule ? ` · ${formatResetTime(upcomingSchedule)}` : null}
      </Text>
      {status ? (
        <Text className="text-2xs text-foreground-muted">
          {latestReset
            ? `Latest reset: ${formatResetTime(latestReset.announced_at)} (${latestReset.reset_type === "banked" ? "Banked" : "Manual"})`
            : "No reset recorded"}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Data from Codex Resets"
        accessibilityHint="Opens the independent Codex reset tracker"
        className="self-start py-1"
        hitSlop={8}
        onPress={() => void Linking.openURL(CODEX_RESETS_URL).catch(() => undefined)}
      >
        <Text className="text-3xs text-foreground-muted underline">Data from Codex Resets</Text>
      </Pressable>
    </View>
  );
}
