import type { MinesCatalogEntry, MinesCatalogSnapshot } from "@t3tools/contracts/minesCatalog";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import * as RemoteAuthorization from "../authorization/service.ts";
import * as Supervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";

const activeStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const encodeCursor = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
export const PASSIVE_HISTORY_PREFETCH_BYTES = 8 * 1024 ** 2;
export type HistoryPrefetchThread = {
  environmentId: EnvironmentId;
  thread: Pick<
    OrchestrationV2ThreadShell,
    "id" | "status" | "updatedAt" | "archivedAt" | "deletedAt"
  >;
};

export function historyPrefetchCandidates(
  catalog: MinesCatalogSnapshot,
  threads: readonly HistoryPrefetchThread[],
) {
  if (threads.some(({ thread }) => activeStatuses.has(thread.status))) return [];
  const eligible = threads.filter(
    ({ thread }) => thread.deletedAt === null && thread.archivedAt === null,
  );
  const key = (environmentId: string, threadId: string) => encodeCursor([environmentId, threadId]);
  const indexed = new Map(
    eligible.map((value) => [key(value.environmentId, value.thread.id), value]),
  );
  const ordered = new Map<string, HistoryPrefetchThread>();
  const addPinned = (entry: MinesCatalogEntry) => {
    const ref = entry.entity.hostRef;
    if (entry.entity.kind === "thread" && ref) {
      const id = key(ref.environmentId, ref.entityId);
      const value = indexed.get(id);
      if (value) ordered.set(id, value);
    }
    for (const child of entry.children) addPinned(child);
  };
  for (const pin of catalog.pins) addPinned(pin);
  for (const value of eligible.sort(
    (a, b) =>
      DateTime.toEpochMillis(b.thread.updatedAt) - DateTime.toEpochMillis(a.thread.updatedAt),
  )) {
    const id = key(value.environmentId, value.thread.id);
    if (!ordered.has(id)) ordered.set(id, value);
  }
  return [...ordered.values()].map(({ environmentId, thread }) => ({
    environmentId,
    input: { threadId: thread.id, updatedAt: DateTime.toEpochMillis(thread.updatedAt) },
  }));
}

// Passive warming takes one older page per thread; the open conversation owns deeper prefetch.
export const prefetchThreadHistory = Effect.fn("ThreadHistory.prefetch")(function* (input: {
  threadId: ThreadId;
  updatedAt: number;
  ownerId: string;
}) {
  const supervisor = yield* Supervisor.EnvironmentSupervisor;
  const optionalCache = yield* Effect.serviceOption(Persistence.EnvironmentCacheStore);
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(optionalCache) || Option.isNone(client))
    return { status: "paused" as const, bytes: 0 };
  const cache = optionalCache.value;
  if (cache.currentOwnerId?.() !== input.ownerId) return { status: "paused" as const, bytes: 0 };
  if (
    !cache.prefetchAllowed ||
    !cache.backgroundPrefetchAllowed ||
    !cache.saveHistoryPage ||
    !cache.loadHistoryPage ||
    !(yield* cache.prefetchAllowed)
  )
    return { status: "paused" as const, bytes: 0 };
  const isCurrentOwner = cache.captureOwner?.() ?? (() => true);
  if (cache.awaitForegroundIdle) yield* cache.awaitForegroundIdle;
  if (!isCurrentOwner() || !(yield* cache.backgroundPrefetchAllowed))
    return { status: "paused" as const, bytes: 0 };
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return { status: "paused" as const, bytes: 0 };
  const environmentId = supervisor.target.environmentId;
  const saved = yield* cache.loadThread(environmentId, input.threadId);
  let snapshot = Option.getOrUndefined(saved);
  let bytes = 0;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteAuthorization.RemoteEnvironmentAuthorization,
  );
  if (
    !snapshot ||
    DateTime.toEpochMillis(snapshot.projection.thread.updatedAt) !== input.updatedAt
  ) {
    if (cache.inspectHistoryCache) {
      const usage = yield* cache.inspectHistoryCache;
      if (usage.entries.reduce((total, entry) => total + entry.bytes, 0) >= usage.budgetBytes * 0.9)
        return { status: "paused" as const, bytes };
    }
    const fetched = yield* fetchEnvironmentBoundedThreadSnapshot({
      prepared: prepared.value,
      threadId: input.threadId,
      signer,
      remoteAuthorization,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
    if (!isCurrentOwner()) return { status: "paused" as const, bytes };
    snapshot = fetched;
    yield* cache.saveThread(environmentId, fetched);
    bytes += 256 * 1024;
  }
  if (!isCurrentOwner() || !(yield* cache.backgroundPrefetchAllowed))
    return { status: "paused" as const, bytes };
  const cursor = snapshot.historyCursor;
  if (cursor) {
    const cacheCursor = encodeCursor([cursor, null, null]);
    const page = yield* cache.loadHistoryPage(environmentId, input.threadId, cacheCursor);
    if (Option.isNone(page)) {
      const fetched = yield* fetchEnvironmentThreadHistoryPage({
        prepared: prepared.value,
        threadId: input.threadId,
        cursor,
        signer,
        remoteAuthorization,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
      if (!isCurrentOwner()) return { status: "paused" as const, bytes };
      yield* cache.saveHistoryPage(environmentId, input.threadId, cacheCursor, fetched);
      bytes += 256 * 1024;
    }
  }
  return { status: bytes === 0 ? ("cached" as const) : ("loaded" as const), bytes };
});
