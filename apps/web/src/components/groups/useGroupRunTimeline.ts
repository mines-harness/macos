import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
  type CommandOutputView,
} from "@t3tools/client-runtime/state/command-output";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GroupRunProjection,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2ProjectedTurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import type { SharedGroupGetInput } from "@t3tools/contracts/sharedGroups";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useStableCallback } from "../../hooks/useStableCallback";
import { groupRunBodyRange, groupRunItem, groupRunPage } from "../../state/groups";
import {
  sharedGroupRunBodyRange,
  sharedGroupRunItem,
  sharedGroupRunPage,
} from "../../state/sharedGroups";
import type { TurnItemSource } from "../chat/timelineRowContext";
import {
  selectGroupRunProjections,
  prependGroupItemBody,
  type GroupTranscriptSnapshot,
} from "./groupTranscript";

const commandAtoms = new WeakMap<
  Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>,
  Atom.Atom<AsyncResult.AsyncResult<CommandOutputView, unknown>>
>();
function commandOutputAtom(
  item: Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>,
) {
  let atom = commandAtoms.get(item);
  if (!atom) {
    atom = Atom.map(item, (result) =>
      AsyncResult.map(result, ({ item }) =>
        applyCommandOutputFrame(EMPTY_COMMAND_OUTPUT, {
          kind: "replace",
          text: item?.type === "command_execution" ? (item.output ?? "") : "",
          running: item?.status === "running",
          truncated: false,
        }),
      ),
    );
    commandAtoms.set(item, atom);
  }
  return atom;
}

export function useGroupRunTimeline({
  environmentId,
  snapshot,
  sharedAddress,
  coordinatorEnvironmentId = environmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GroupTranscriptSnapshot;
  readonly sharedAddress?: SharedGroupGetInput;
  readonly coordinatorEnvironmentId?: EnvironmentId;
}) {
  const [loaded, setLoaded] = useState<ReadonlyArray<GroupRunProjection>>([]);
  const [busyDelivery, setBusyDelivery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const lifetime = useRef({ live: true });
  const pagePending = useRef(false);
  const readPage = useAtomQueryRunner(groupRunPage, { reportFailure: false, refresh: true });
  const readSharedPage = useAtomQueryRunner(sharedGroupRunPage, {
    reportFailure: false,
    refresh: true,
  });
  const readItem = useAtomQueryRunner(groupRunItem, { reportFailure: false, refresh: true });
  const readSharedItem = useAtomQueryRunner(sharedGroupRunItem, {
    reportFailure: false,
    refresh: true,
  });
  const readBody = useAtomQueryRunner(groupRunBodyRange, { reportFailure: false, refresh: true });
  const readSharedBody = useAtomQueryRunner(sharedGroupRunBodyRange, {
    reportFailure: false,
    refresh: true,
  });
  const selection = selectGroupRunProjections(snapshot, loaded, coordinatorEnvironmentId);
  if (selection.loaded.length !== loaded.length) setLoaded(selection.loaded);
  const projections = selection.projections;
  const readProjections = useStableCallback(() => projections);
  const readMissing = useStableCallback(() => selection.missing);
  const remember = (projection: GroupRunProjection) =>
    setLoaded((current) => [...current, projection]);
  const itemQuery = (deliveryId: string, itemId: TurnItemId, revision?: string) =>
    sharedAddress
      ? sharedGroupRunItem({
          environmentId,
          input: { ...sharedAddress, deliveryId, itemId, ...(revision ? { revision } : {}) },
        })
      : groupRunItem({
          environmentId,
          input: {
            groupId: snapshot.group.id,
            deliveryId,
            itemId,
            ...(revision ? { revision } : {}),
          },
        });
  const source = (deliveryId: string): TurnItemSource => ({
    detail: ({ itemId, revision }) => itemQuery(deliveryId, itemId, revision),
    commandOutput: ({ itemId }) => commandOutputAtom(itemQuery(deliveryId, itemId)),
  });
  const loadEarlierBody = async (deliveryId: string, row: OrchestrationV2ProjectedTurnItem) => {
    const projection = projections.find((projection) => projection.deliveryId === deliveryId);
    const range = row.item.bodyRange;
    if (!projection || !range) return;
    const input = {
      deliveryId,
      itemId: row.sourceItemId,
      field: range.field,
      before: range.startByte,
      revision: range.revision,
    };
    const result = sharedAddress
      ? await readSharedBody({ environmentId, input: { ...sharedAddress, ...input } })
      : await readBody({ environmentId, input: { groupId: snapshot.group.id, ...input } });
    if (
      !readProjections().some(
        (current) =>
          current.deliveryId === projection.deliveryId && current.runId === projection.runId,
      )
    )
      return;
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    if (!result.value) throw new Error("This part of the message is no longer available.");
    const updated = prependGroupItemBody(row.item, result.value);
    if (updated === row.item)
      throw new Error("The message changed. Open its latest content and try again.");
    remember({ ...projection, items: [updated], deferredItems: [] });
  };
  const loadEarlier = async (projection: GroupRunProjection) => {
    if (pagePending.current || !projection.hasMoreItems || projection.beforeOrdinal === null)
      return;
    pagePending.current = true;
    setBusyDelivery(projection.deliveryId);
    setError(null);
    const input = { deliveryId: projection.deliveryId, beforeOrdinal: projection.beforeOrdinal };
    const result = sharedAddress
      ? await readSharedPage({ environmentId, input: { ...sharedAddress, ...input } })
      : await readPage({ environmentId, input: { groupId: snapshot.group.id, ...input } });
    pagePending.current = false;
    if (!lifetime.current.live) return;
    setBusyDelivery(null);
    if (
      !readProjections().some(
        (current) =>
          current.deliveryId === projection.deliveryId && current.runId === projection.runId,
      )
    )
      return;
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not load earlier activity.");
      return;
    }
    remember(result.value);
  };
  const loadNextMissing = async () => {
    const target = readMissing()[0];
    if (pagePending.current || !target) return;
    pagePending.current = true;
    setBusyDelivery(target.deliveryId);
    setError(null);
    const input = { deliveryId: target.deliveryId };
    const result = sharedAddress
      ? await readSharedPage({ environmentId, input: { ...sharedAddress, ...input } })
      : await readPage({ environmentId, input: { groupId: snapshot.group.id, ...input } });
    pagePending.current = false;
    if (!lifetime.current.live) return;
    setBusyDelivery(null);
    if (
      !readMissing().some(
        (current) =>
          current.deliveryId === target.deliveryId &&
          current.runId === target.runId &&
          current.memberId === target.memberId &&
          current.environmentId === target.environmentId &&
          current.threadId === target.threadId,
      )
    )
      return;
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not load agent activity.");
      return;
    }
    remember(result.value);
  };
  const materialize = async () => {
    const scope = lifetime.current;
    for (const projection of projections) {
      for (const item of projection.deferredItems) {
        const key = JSON.stringify([
          projection.deliveryId,
          projection.runId,
          item.id,
          item.revision,
        ]);
        if (pending.current.has(key)) continue;
        pending.current.add(key);
        const input = {
          deliveryId: projection.deliveryId,
          itemId: item.id,
          revision: item.revision,
        };
        const result = sharedAddress
          ? await readSharedItem({ environmentId, input: { ...sharedAddress, ...input } })
          : await readItem({ environmentId, input: { groupId: snapshot.group.id, ...input } });
        if (!scope.live) {
          pending.current.delete(key);
          return;
        }
        const current = readProjections().find(
          (candidate) =>
            candidate.deliveryId === projection.deliveryId && candidate.runId === projection.runId,
        );
        if (!current) {
          pending.current.delete(key);
          continue;
        }
        if (result._tag === "Success" && result.value.item)
          remember({ ...projection, items: [result.value.item], deferredItems: [] });
        else {
          pending.current.delete(key);
          if (
            current.deferredItems.some(
              (candidate) => candidate.id === item.id && candidate.revision === item.revision,
            )
          ) {
            const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
            setError(
              failure instanceof Error ? failure.message : "This activity is no longer available.",
            );
          }
        }
      }
    }
  };
  const materializeEffect = useEffectEvent(materialize);
  const deferredKey = JSON.stringify(
    projections.flatMap((projection) =>
      projection.deferredItems.map((item) => [
        projection.deliveryId,
        projection.runId,
        item.id,
        item.revision,
      ]),
    ),
  );
  // oxlint-disable-next-line mines/react-effect-budget -- Oversized native rows are materialized through the authorized group route when their references arrive.
  useEffect(() => {
    const scope = lifetime.current;
    scope.live = true;
    if (deferredKey !== "[]") {
      // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the authorized item query resolves.
      void materializeEffect();
    }
    return () => {
      scope.live = false;
    };
  }, [deferredKey]);
  return {
    snapshot: { ...snapshot, runProjections: projections },
    projections,
    source,
    loadEarlierBody,
    loadEarlier,
    loadNextMissing,
    missingCount: selection.missing.length,
    busyDelivery,
    error,
    retryDeferred: () => {
      pending.current.clear();
      setError(null);
      void materialize();
    },
  };
}
