import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type OrchestrationV2ThreadHistoryPage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import { createEncryptedHistoryCache, type PrivateHistoryStorage } from "./historyCache.ts";
import { EnvironmentCacheStore } from "./persistence.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";

const env = EnvironmentId.make("host");
const page: OrchestrationV2ThreadHistoryPage = {
  snapshotSequence: 10,
  items: [],
  nextCursor: null,
  hasMoreHistory: false,
};

function setup(budgetBytes = 1024 ** 2) {
  let account = "first";
  const records = new Map<string, Map<string, Uint8Array>>();
  const base = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.die("Plaintext write"),
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.die("Plaintext write"),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const cache = createEncryptedHistoryCache({
    base,
    accountId: () => account,
    budgetBytes,
    unmetered: async () => true,
    open: async (owner): Promise<PrivateHistoryStorage> => {
      const values = records.get(owner) ?? new Map<string, Uint8Array>();
      records.set(owner, values);
      return {
        read: async (key) => values.get(key) ?? null,
        write: async (key, value) => {
          values.set(key, value);
        },
        remove: async (key) => {
          values.delete(key);
        },
      };
    },
  });
  return {
    cache,
    records,
    switchAccount: (value: string) => {
      account = value;
    },
  };
}

describe("encrypted history cache", () => {
  it.effect(
    "waits for foreground work, ignores another account's activity, and invalidates captured owners",
    () =>
      Effect.gen(function* () {
        const { cache, switchAccount } = setup();
        const currentOwner = cache.captureOwner!();
        const activity = cache.foregroundActivity!();
        expect(yield* cache.backgroundPrefetchAllowed!).toBe(false);
        const waiting = yield* cache.awaitForegroundIdle!.pipe(Effect.forkChild);
        activity.setBusy(false);
        yield* Fiber.join(waiting);
        expect(yield* cache.backgroundPrefetchAllowed!).toBe(true);
        activity.setBusy(true);
        switchAccount("second");
        expect(currentOwner()).toBe(false);
        expect(yield* cache.backgroundPrefetchAllowed!).toBe(true);
        activity.dispose();
      }),
  );

  it.effect(
    "persists fetched body ranges for offline expansion and removes them with their thread",
    () =>
      Effect.gen(function* () {
        const { cache } = setup();
        const body = {
          text: "earlier",
          range: {
            field: "text" as const,
            startByte: 0,
            endByte: 7,
            totalBytes: 20,
            revision: "revision",
          },
        };
        yield* cache.saveBodyRange!(env, v2ThreadId, "body:cursor", body);
        expect(
          Option.getOrThrow(yield* cache.loadBodyRange!(env, v2ThreadId, "body:cursor")),
        ).toEqual(body);
        yield* cache.removeThread(env, v2ThreadId);
        expect(Option.isNone(yield* cache.loadBodyRange!(env, v2ThreadId, "body:cursor"))).toBe(
          true,
        );
      }),
  );

  it.effect("keeps fetched pages, snapshots and cursors without plaintext writes", () =>
    Effect.gen(function* () {
      const { cache } = setup();
      const snapshot = {
        snapshotSequence: 10,
        projection: v2Projection,
        historyCursor: "older",
        hasMoreHistory: true,
      };
      yield* cache.saveThread(env, snapshot);
      yield* cache.saveHistoryPage!(env, v2ThreadId, "older", page);
      expect(Option.getOrThrow(yield* cache.loadThread(env, v2ThreadId))).toEqual(snapshot);
      expect(Option.getOrThrow(yield* cache.loadHistoryPage!(env, v2ThreadId, "older"))).toEqual(
        page,
      );
    }),
  );

  it.effect("separates account data and clears all pages when a thread is removed", () =>
    Effect.gen(function* () {
      const { cache, switchAccount } = setup();
      yield* cache.saveHistoryPage!(env, v2ThreadId, "cursor", page);
      switchAccount("second");
      expect(Option.isNone(yield* cache.loadHistoryPage!(env, v2ThreadId, "cursor"))).toBe(true);
      switchAccount("first");
      expect(Option.isSome(yield* cache.loadHistoryPage!(env, v2ThreadId, "cursor"))).toBe(true);
      yield* cache.removeThread(env, v2ThreadId);
      expect(Option.isNone(yield* cache.loadHistoryPage!(env, v2ThreadId, "cursor"))).toBe(true);
    }),
  );

  it.effect("evicts old pages but protects an active tail under storage pressure", () =>
    Effect.gen(function* () {
      const { cache } = setup(256);
      const release = yield* cache.protectThread!(env, v2ThreadId);
      yield* cache.saveThread(env, { snapshotSequence: 10, projection: v2Projection });
      yield* cache.saveHistoryPage!(env, v2ThreadId, "old", page);
      expect(Option.isSome(yield* cache.loadThread(env, v2ThreadId))).toBe(true);
      expect(Option.isNone(yield* cache.loadHistoryPage!(env, v2ThreadId, "old"))).toBe(true);
      release();
      yield* cache.saveHistoryPage!(env, v2ThreadId, "new", page);
      expect(Option.isNone(yield* cache.loadThread(env, v2ThreadId))).toBe(true);
      expect(Option.isSome(yield* cache.loadHistoryPage!(env, v2ThreadId, "new"))).toBe(true);
    }),
  );
});
