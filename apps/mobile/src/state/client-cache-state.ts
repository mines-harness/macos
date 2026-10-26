import { Persistence } from "@t3tools/client-runtime/platform";
import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import * as MobileDatabase from "../persistence/mobile-database";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";

export interface EnvironmentClientCacheSummary {
  readonly environmentId: EnvironmentId;
  readonly recordCount: number;
  readonly payloadBytes: number;
  readonly kinds: Readonly<Partial<Record<MobileDatabase.ClientCacheKind, number>>>;
}

export interface ClientCacheSummary {
  readonly recordCount: number;
  readonly payloadBytes: number;
  readonly environments: ReadonlyArray<EnvironmentClientCacheSummary>;
}

export type ClientCacheClearScope =
  | { readonly type: "all" }
  | { readonly type: "environment"; readonly environmentId: EnvironmentId };

function aggregateCacheSummary(
  rows: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly kind: MobileDatabase.ClientCacheKind;
    readonly recordCount: number;
    readonly payloadBytes: number;
  }>,
): ClientCacheSummary {
  const environments = new Map<EnvironmentId, EnvironmentClientCacheSummary>();
  let recordCount = 0;
  let payloadBytes = 0;

  for (const row of rows) {
    recordCount += row.recordCount;
    payloadBytes += row.payloadBytes;
    const current = environments.get(row.environmentId) ?? {
      environmentId: row.environmentId,
      recordCount: 0,
      payloadBytes: 0,
      kinds: {},
    };
    environments.set(row.environmentId, {
      environmentId: row.environmentId,
      recordCount: current.recordCount + row.recordCount,
      payloadBytes: current.payloadBytes + row.payloadBytes,
      kinds: { ...current.kinds, [row.kind]: row.recordCount },
    });
  }

  return {
    recordCount,
    payloadBytes,
    environments: [...environments.values()],
  };
}

export const clientCacheSummaryAtom = connectionAtomRuntime
  .atom(
    MobileDatabase.MobileDatabase.pipe(
      Effect.flatMap((database) => database.inspectCaches),
      Effect.flatMap((rows) =>
        Persistence.EnvironmentCacheStore.pipe(
          Effect.flatMap(
            (cache) => cache.inspectHistoryCache ?? Effect.succeed({ budgetBytes: 0, entries: [] }),
          ),
          Effect.map((history) =>
            aggregateCacheSummary([
              ...rows,
              ...history.entries.map((entry) => ({
                environmentId: entry.environmentId,
                kind: entry.kind === "shell" ? ("shell" as const) : ("thread" as const),
                recordCount: 1,
                payloadBytes: entry.bytes,
              })),
            ]),
          ),
        ),
      ),
    ),
  )
  .pipe(Atom.withLabel("mobile:client-cache:summary"));

export const clearClientCacheAtom = connectionAtomRuntime
  .fn((scope: ClientCacheClearScope, get) =>
    Effect.promise(() =>
      scope.type === "all"
        ? projectFaviconDatabaseCache.clearAll()
        : projectFaviconDatabaseCache.clearEnvironment(scope.environmentId),
    ).pipe(
      Effect.andThen(MobileDatabase.MobileDatabase),
      Effect.flatMap((database) =>
        scope.type === "all"
          ? database.clearAllCaches
          : database.clearEnvironmentCache(scope.environmentId),
      ),
      Effect.andThen(Persistence.EnvironmentCacheStore),
      Effect.flatMap((cache) =>
        scope.type === "all"
          ? (cache.clearHistoryCache ?? Effect.void)
          : cache.clear(scope.environmentId),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          get.refresh(clientCacheSummaryAtom);
        }),
      ),
    ),
  )
  .pipe(Atom.withLabel("mobile:client-cache:clear"));

export const historyCacheSummaryAtom = connectionAtomRuntime.atom(
  Persistence.EnvironmentCacheStore.pipe(
    Effect.flatMap(
      (cache) =>
        cache.inspectHistoryCache ?? Effect.succeed({ budgetBytes: 1024 ** 3, entries: [] }),
    ),
  ),
);
export const setHistoryCacheBudgetAtom = connectionAtomRuntime.fn((bytes: number, get) =>
  Persistence.EnvironmentCacheStore.pipe(
    Effect.flatMap((cache) => cache.setHistoryCacheBudget?.(bytes) ?? Effect.void),
    Effect.tap(() =>
      Effect.sync(() => {
        get.refresh(historyCacheSummaryAtom);
        get.refresh(clientCacheSummaryAtom);
      }),
    ),
  ),
);
