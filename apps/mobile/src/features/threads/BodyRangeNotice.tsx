import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function BodyRangeNotice({
  row,
  environmentId,
  threadId,
}: {
  row?: OrchestrationV2ProjectedTurnItem | undefined;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useAtomCommand(threadEnvironment.loadEarlierBody, { reportFailure: false });
  if (!row?.item.bodyRange || row.item.bodyRange.startByte === 0) return null;
  return (
    <View className="mb-2">
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setError(null);
          void load({
            environmentId,
            input: { threadId, sourceThreadId: row.sourceThreadId, itemId: row.sourceItemId },
          })
            .then((result) => {
              if (result._tag === "Success" && result.value._tag === "error")
                setError(result.value.message);
              else if (result._tag === "Failure") setError("Could not load earlier content.");
            })
            .finally(() => setBusy(false));
        }}
      >
        <Text className="text-link py-2">
          {busy ? "Loading earlier content…" : "Load earlier content"}
        </Text>
      </Pressable>
      <Text className="text-muted-foreground text-xs">
        Showing the latest part of this message.
      </Text>
      {error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      )}
    </View>
  );
}
