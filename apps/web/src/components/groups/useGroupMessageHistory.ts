import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GroupMessage, GroupSnapshot } from "@t3tools/contracts";
import type { SharedGroupGetInput } from "@t3tools/contracts/sharedGroups";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  groupMessageChunk,
  groupMessageHistory,
  sharedGroupMessageChunk,
  sharedGroupMessageHistory,
} from "../../state/groupMessageHistory";
import {
  groupMessageSourceKey,
  mergeGroupHistory,
  pruneGroupHistoryProjections,
  readCompleteGroupMessage,
} from "./groupMessageHistory";

interface HistoryState {
  readonly identity: string;
  readonly pages: ReadonlyArray<GroupSnapshot>;
  readonly resolved: ReadonlyMap<
    string,
    { readonly source: string; readonly message: GroupMessage }
  >;
  readonly hasMore: boolean | null;
  readonly loading: number;
  readonly error: string | null;
  readonly lastLive: GroupSnapshot;
}
const initial = (identity: string, snapshot: GroupSnapshot): HistoryState => ({
  identity,
  pages: [],
  resolved: new Map(),
  hasMore: null,
  loading: 0,
  error: null,
  lastLive: snapshot,
});

export function useGroupMessageHistory({
  environmentId,
  snapshot,
  sharedAddress,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GroupSnapshot;
  readonly sharedAddress?: SharedGroupGetInput;
}): {
  readonly snapshot: GroupSnapshot;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadEarlier: () => void;
  readonly retryDeferred: () => void;
} {
  const identity = JSON.stringify([environmentId, snapshot.group.id, sharedAddress]);
  const [stored, setStored] = useState(() => initial(identity, snapshot));
  let state = stored.identity === identity ? stored : initial(identity, snapshot);
  if (stored.identity !== identity) setStored(state);
  else if (state.lastLive !== snapshot) {
    const ids = new Set(snapshot.messages.map((message) => message.id));
    const evicted = state.lastLive.messages.filter((message) => !ids.has(message.id));
    state = {
      ...state,
      lastLive: snapshot,
      pages: pruneGroupHistoryProjections(
        snapshot,
        evicted.length ? [...state.pages, { ...state.lastLive, messages: evicted }] : state.pages,
      ),
    };
    setStored(state);
  }
  const lifetime = useRef({
    identity,
    live: true,
    pending: new Set<string>(),
    attempted: new Set<string>(),
  });
  const readHistory = useAtomQueryRunner(groupMessageHistory, {
    reportFailure: false,
    refresh: true,
  });
  const readSharedHistory = useAtomQueryRunner(sharedGroupMessageHistory, {
    reportFailure: false,
    refresh: true,
  });
  const readChunk = useAtomQueryRunner(groupMessageChunk, { reportFailure: false, refresh: true });
  const readSharedChunk = useAtomQueryRunner(sharedGroupMessageChunk, {
    reportFailure: false,
    refresh: true,
  });
  const update = (change: (current: HistoryState) => HistoryState) =>
    setStored((current) =>
      current.identity === identity &&
      lifetime.current.identity === identity &&
      lifetime.current.live
        ? change(current)
        : current,
    );
  // oxlint-disable-next-line mines/react-effect-budget -- cancels outstanding authorized range reads when this conversation unmounts
  useEffect(() => {
    const current = {
      identity,
      live: true,
      pending: new Set<string>(),
      attempted: new Set<string>(),
    };
    lifetime.current = current;
    return () => {
      current.live = false;
    };
  }, [identity]);
  const merged = mergeGroupHistory(snapshot, state.pages);
  const complete = {
    ...merged,
    hasMoreMessages: state.hasMore ?? snapshot.hasMoreMessages,
    messages: merged.messages.map((message) => {
      const loaded = state.resolved.get(message.id);
      return loaded?.source === groupMessageSourceKey(message) ? loaded.message : message;
    }),
  };
  const readSnapshot = useStableCallback(() => complete);
  const loadEarlier = () => {
    const scope = lifetime.current;
    const request = `${identity}:history`;
    if (scope.pending.has(request)) return;
    scope.pending.add(request);
    update((current) => ({ ...current, loading: current.loading + 1, error: null }));
    return Promise.resolve()
      .then(async () => {
        const beforeMessageId = readSnapshot().messages[0]?.id;
        return sharedAddress
          ? await readSharedHistory({
              environmentId,
              input: { ...sharedAddress, ...(beforeMessageId ? { beforeMessageId } : {}) },
            })
          : await readHistory({
              environmentId,
              input: {
                groupId: snapshot.group.id,
                ...(beforeMessageId ? { beforeMessageId } : {}),
              },
            });
      })
      .then((result) => {
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const page = "snapshot" in result.value ? result.value.snapshot : result.value;
        if (!page || page.group.id !== snapshot.group.id)
          throw new Error("The group history is unavailable.");
        update((current) => ({
          ...current,
          pages: pruneGroupHistoryProjections(readSnapshot(), [page, ...current.pages]),
          hasMore: page.hasMoreMessages,
        }));
      })
      .catch((cause: unknown) => {
        update((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Could not load earlier group messages.",
        }));
      })
      .finally(() => {
        scope.pending.delete(request);
        update((current) => ({ ...current, loading: Math.max(0, current.loading - 1) }));
      });
  };
  const deferred = merged.messages.filter(
    (message) =>
      !message.streaming &&
      (message.truncated || message.contextDeferred) &&
      state.resolved.get(message.id)?.source !== groupMessageSourceKey(message),
  );
  const deferredKey = JSON.stringify(deferred.map(groupMessageSourceKey));
  const hydrate = useStableCallback(async () => {
    const scope = lifetime.current;
    for (const message of deferred) {
      const source = groupMessageSourceKey(message);
      const request = `${identity}:${source}`;
      if (!scope.live || scope.attempted.has(request) || scope.pending.has(request)) continue;
      scope.attempted.add(request);
      scope.pending.add(request);
      update((current) => ({ ...current, loading: current.loading + 1 }));
      await readCompleteGroupMessage(
        message,
        async (offset) => {
          const result = sharedAddress
            ? await readSharedChunk({
                environmentId,
                input: { ...sharedAddress, messageId: message.id, offset },
              })
            : await readChunk({
                environmentId,
                input: { groupId: snapshot.group.id, messageId: message.id, offset },
              });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        () => scope.live,
        !!sharedAddress,
      )
        .then((loaded) => {
          update((current) => ({
            ...current,
            resolved: new Map([...current.resolved, [message.id, { source, message: loaded }]]),
          }));
        })
        .catch((cause: unknown) => {
          update((current) => ({
            ...current,
            error:
              cause instanceof Error ? cause.message : "Could not load the full group message.",
          }));
        })
        .finally(() => {
          scope.pending.delete(request);
          update((current) => ({ ...current, loading: Math.max(0, current.loading - 1) }));
        });
    }
  });
  // oxlint-disable-next-line mines/react-effect-budget -- hydrates only deferred rows in the currently loaded bounded history window
  useEffect(() => {
    if (deferredKey !== "[]") void hydrate();
  }, [hydrate, deferredKey]);
  return {
    snapshot: complete,
    hasMore: state.hasMore ?? snapshot.hasMoreMessages,
    loading: state.loading > 0,
    error: state.error,
    loadEarlier: () => {
      void loadEarlier();
    },
    retryDeferred: () => {
      lifetime.current.attempted.clear();
      update((current) => ({ ...current, error: null }));
      void hydrate();
    },
  };
}
