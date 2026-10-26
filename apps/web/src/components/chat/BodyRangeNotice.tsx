import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function BodyRangeNotice({
  row,
  threadRef,
}: {
  row?: OrchestrationV2ProjectedTurnItem | undefined;
  threadRef?: ScopedThreadRef | null | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useAtomCommand(threadEnvironment.loadEarlierBody, { reportFailure: false });
  if (!row || !threadRef || !row.item.bodyRange || row.item.bodyRange.startByte === 0) return null;
  return (
    <div className="mb-2 text-xs text-muted-foreground">
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void load({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              sourceThreadId: row.sourceThreadId,
              itemId: row.sourceItemId,
            },
          })
            .then((result) => {
              if (result._tag === "Success" && result.value._tag === "error")
                setError(result.value.message);
              else if (result._tag === "Failure") setError("Could not load earlier content.");
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Loading earlier content…" : "Load earlier content"}
      </Button>
      <span> Showing the latest part of this message.</span>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
