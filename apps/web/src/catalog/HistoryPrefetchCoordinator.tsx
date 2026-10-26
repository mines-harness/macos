import { useAtomValue } from "@effect/atom-react";
import { minesAccountEnvironmentIdsAtom } from "@t3tools/client-runtime/catalog";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  historyPrefetchCandidates,
  PASSIVE_HISTORY_PREFETCH_BYTES,
} from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { environmentCatalog } from "../connection/catalog";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useMinesCatalog } from "./useMinesCatalog";

const threadsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const owned = get(minesAccountEnvironmentIdsAtom);
  return [...enabledEnvironmentIds(catalog)]
    .filter(
      (id) => owned.has(id) || catalog.entries.get(id)?.target._tag === "PrimaryConnectionTarget",
    )
    .flatMap((environmentId) =>
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).map((thread) => ({
        environmentId,
        thread,
      })),
    );
});

export function HistoryPrefetchCoordinator() {
  const { snapshot, accountId } = useMinesCatalog();
  const threads = useAtomValue(threadsAtom);
  const prefetch = useAtomCommand(threadEnvironment.prefetchHistory, { reportFailure: false });
  useEffect(() => {
    let cancelled = false;
    const candidates = historyPrefetchCandidates(snapshot, threads);
    void (async () => {
      let bytes = 0;
      for (const candidate of candidates) {
        if (cancelled || bytes >= PASSIVE_HISTORY_PREFETCH_BYTES) return;
        const result = await prefetch({
          ...candidate,
          input: { ...candidate.input, ownerId: accountId },
        });
        if (result._tag === "Failure") continue;
        bytes += result.value.bytes;
        if (result.value.status === "paused") return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, threads, prefetch, accountId]);
  return null;
}
