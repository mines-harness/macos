import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Persistence } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const summaryAtom = connectionAtomRuntime.atom(
  Persistence.EnvironmentCacheStore.pipe(
    Effect.flatMap(
      (cache) =>
        cache.inspectHistoryCache ?? Effect.succeed({ budgetBytes: 5 * 1024 ** 3, entries: [] }),
    ),
  ),
);
const budgetAtom = connectionAtomRuntime.fn((bytes: number, get) =>
  Persistence.EnvironmentCacheStore.pipe(
    Effect.flatMap((cache) => cache.setHistoryCacheBudget?.(bytes) ?? Effect.void),
    Effect.tap(() => Effect.sync(() => get.refresh(summaryAtom))),
  ),
);
const clearAtom = connectionAtomRuntime.fn((_input: void, get) =>
  Persistence.EnvironmentCacheStore.pipe(
    Effect.flatMap((cache) => cache.clearHistoryCache ?? Effect.void),
    Effect.tap(() => Effect.sync(() => get.refresh(summaryAtom))),
  ),
);

export function HistoryCacheSettings() {
  const summary = useAtomValue(summaryAtom);
  const budget = useAtomValue(budgetAtom);
  const clearing = useAtomValue(clearAtom);
  const setBudget = useAtomSet(budgetAtom);
  const clear = useAtomSet(clearAtom);
  const selected = AsyncResult.isSuccess(summary) ? summary.value.budgetBytes : 5 * 1024 ** 3;
  return (
    <SettingsSection id="storage-offline-history" title="Offline history on this device">
      <SettingsRow
        title="Encrypted cache budget"
        description="Older cached pages are removed first. Active tails, drafts and the owning computer's original histories are preserved."
        control={
          <div className="flex gap-2">
            {[1, 5, 10].map((gib) => (
              <Button
                key={gib}
                size="sm"
                variant={selected === gib * 1024 ** 3 ? "default" : "outline"}
                disabled={budget.waiting}
                onClick={() => setBudget(gib * 1024 ** 3)}
              >
                {gib} GiB
              </Button>
            ))}
          </div>
        }
      />
      <SettingsRow
        title="Clear downloaded history"
        description="This only removes cached copies on this device."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={clearing.waiting}
            onClick={() => clear(undefined)}
          >
            Clear cache
          </Button>
        }
      />
      {(AsyncResult.isFailure(budget) ||
        AsyncResult.isFailure(clearing) ||
        AsyncResult.isFailure(summary)) && (
        <p role="alert" className="text-sm text-destructive">
          Encrypted cache storage is unavailable.
        </p>
      )}
    </SettingsSection>
  );
}
