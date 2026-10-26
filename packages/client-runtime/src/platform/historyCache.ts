import {
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2BodyRangeResult,
  EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Persistence from "./persistence.ts";
import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";

export const DESKTOP_HISTORY_CACHE_BYTES = 5 * 1024 ** 3;
export const MOBILE_HISTORY_CACHE_BYTES = 1024 ** 3;

export interface PrivateHistoryStorage {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

const Index = Schema.Struct({
  budget: Schema.Number,
  clock: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      environmentId: Schema.String,
      threadId: Schema.NullOr(Schema.String),
      kind: Schema.Literals(["tail", "page", "shell"]),
      bytes: Schema.Number,
      access: Schema.Number,
    }),
  ),
});
type Index = typeof Index.Type;
const encodeIndex = Schema.encodeSync(Schema.fromJsonString(Index));
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const decodeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(Index));
const encodeThread = Schema.encodeSync(Schema.fromJsonString(StoredOrchestrationThreadSnapshot));
const decodeThread = Schema.decodeUnknownSync(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);
const encodeShell = Schema.encodeSync(Schema.fromJsonString(StoredOrchestrationShellSnapshot));
const decodeShell = Schema.decodeUnknownSync(
  Schema.fromJsonString(StoredOrchestrationShellSnapshot),
);
const encodeBody = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2BodyRangeResult));
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2BodyRangeResult));
const encodePage = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ThreadHistoryPage));
const decodePage = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2ThreadHistoryPage),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createEncryptedHistoryCache(input: {
  base: Persistence.EnvironmentCacheStore["Service"];
  accountId: () => string;
  open: (accountId: string) => Promise<PrivateHistoryStorage>;
  budgetBytes: number;
  unmetered?: () => Promise<boolean>;
}): Persistence.EnvironmentCacheStore["Service"] {
  const owners = new Map<string, Promise<{ storage: PrivateHistoryStorage; index: Index }>>();
  const active = new Map<string, number>();
  const foreground = new Map<object, { account: string; busy: boolean }>();
  const idleListeners = new Set<() => void>();
  const isForegroundBusy = (account: string) =>
    [...foreground.values()].some((activity) => activity.account === account && activity.busy);
  let pending: Promise<unknown> = Promise.resolve();
  const key = (environmentId: string, threadId: string | null, kind: string, cursor = "") =>
    `history:${encodeKey([environmentId, threadId, kind, cursor])}`;
  const owner = (account: string) => {
    let value = owners.get(account);
    if (!value) {
      value = input.open(account).then(async (storage) => {
        const saved = await storage.read("history:index");
        return {
          storage,
          index:
            saved === null
              ? { budget: input.budgetBytes, clock: 0, entries: [] }
              : decodeIndex(decoder.decode(saved)),
        };
      });
      owners.set(account, value);
      void value.catch(() => owners.delete(account));
    }
    return value;
  };
  const run = <A>(
    operation: Persistence.ConnectionPersistenceError["operation"],
    f: (state: Awaited<ReturnType<typeof owner>>, account: string) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: () => {
        const account = input.accountId();
        const task = pending.then(async () => f(await owner(account), account));
        pending = task.catch(() => undefined);
        return task;
      },
      catch: (cause) =>
        new Persistence.ConnectionPersistenceError({
          operation,
          message: `Encrypted history cache: ${String(cause)}`,
        }),
    });
  const persistIndex = async (state: Awaited<ReturnType<typeof owner>>) =>
    state.storage.write("history:index", encoder.encode(encodeIndex(state.index)));
  const trim = async (state: Awaited<ReturnType<typeof owner>>, account: string) => {
    let total = state.index.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const removed = new Set<string>();
    for (const entry of [...state.index.entries].sort((a, b) => a.access - b.access)) {
      if (total <= state.index.budget) break;
      if (
        entry.kind === "shell" ||
        (entry.kind === "tail" &&
          active.has(encodeKey([account, entry.environmentId, entry.threadId])))
      )
        continue;
      await state.storage.remove(entry.key);
      removed.add(entry.key);
      total -= entry.bytes;
    }
    state.index = {
      ...state.index,
      entries: state.index.entries.filter((entry) => !removed.has(entry.key)),
    };
    await persistIndex(state);
  };
  const save = (
    environmentId: EnvironmentId,
    threadId: ThreadId | null,
    kind: "tail" | "page" | "shell",
    text: string,
    cursor = "",
  ) =>
    run(kind === "shell" ? "save-shell" : "save-thread", async (state, account) => {
      const record = key(environmentId, threadId, kind, cursor);
      const bytes = encoder.encode(text);

      const access = state.index.clock + 1;
      state.index = {
        ...state.index,
        clock: access,
        entries: [
          ...state.index.entries.filter((entry) => entry.key !== record),
          {
            key: record,
            environmentId,
            threadId,
            kind,
            bytes: Math.ceil((bytes.byteLength * 4) / 3) + 64,
            access,
          },
        ],
      };
      await persistIndex(state);
      await state.storage.write(record, bytes);
      await trim(state, account);
    });
  const load = <A>(
    environmentId: EnvironmentId,
    threadId: ThreadId | null,
    kind: "tail" | "page" | "shell",
    decode: (text: string) => A,
    cursor = "",
  ) =>
    run(kind === "shell" ? "load-shell" : "load-thread", async (state) => {
      const record = key(environmentId, threadId, kind, cursor);
      const bytes = await state.storage.read(record);
      if (bytes === null) return Option.none<A>();
      try {
        const value = decode(decoder.decode(bytes));
        const access = state.index.clock + 1;
        state.index = {
          ...state.index,
          clock: access,
          entries: state.index.entries.map((entry) =>
            entry.key === record ? { ...entry, access } : entry,
          ),
        };
        return Option.some(value);
      } catch {
        await state.storage.remove(record);
        state.index = {
          ...state.index,
          entries: state.index.entries.filter((entry) => entry.key !== record),
        };
        await persistIndex(state);
        return Option.none<A>();
      }
    });
  const remove = (environmentId: EnvironmentId, threadId?: ThreadId) =>
    run("remove-thread", async (state) => {
      const removing = state.index.entries.filter(
        (entry) =>
          entry.environmentId === environmentId &&
          (threadId === undefined || entry.threadId === threadId),
      );
      for (const entry of removing) await state.storage.remove(entry.key);
      const keys = new Set(removing.map((entry) => entry.key));
      state.index = {
        ...state.index,
        entries: state.index.entries.filter((entry) => !keys.has(entry.key)),
      };
      await persistIndex(state);
    });
  return Persistence.EnvironmentCacheStore.of({
    ...input.base,
    loadShell: (environmentId) =>
      load(environmentId, null, "shell", (text) => decodeShell(text).snapshot),
    saveShell: (environmentId, snapshot) =>
      save(
        environmentId,
        null,
        "shell",
        encodeShell({ schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION, environmentId, snapshot }),
      ),
    loadThread: (environmentId, threadId) =>
      load(environmentId, threadId, "tail", (text) => decodeThread(text).snapshot),
    saveThread: (environmentId, snapshot) =>
      save(
        environmentId,
        snapshot.projection.thread.id,
        "tail",
        encodeThread({
          schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
          environmentId,
          threadId: snapshot.projection.thread.id,
          snapshot,
        }),
      ),
    loadBodyRange: (environmentId, threadId, cursor) =>
      load(environmentId, threadId, "page", decodeBody, cursor),
    saveBodyRange: (environmentId, threadId, cursor, body) =>
      save(environmentId, threadId, "page", encodeBody(body), cursor),
    loadHistoryPage: (environmentId, threadId, cursor) =>
      load(environmentId, threadId, "page", decodePage, cursor),
    saveHistoryPage: (environmentId, threadId, cursor, page) =>
      save(environmentId, threadId, "page", encodePage(page), cursor),
    protectThread: (environmentId, threadId) =>
      Effect.sync(() => {
        const id = encodeKey([input.accountId(), environmentId, threadId]);
        active.set(id, (active.get(id) ?? 0) + 1);
        return () => {
          const count = (active.get(id) ?? 1) - 1;
          if (count === 0) active.delete(id);
          else active.set(id, count);
        };
      }),
    currentOwnerId: input.accountId,
    captureOwner: () => {
      const account = input.accountId();
      return () => input.accountId() === account;
    },
    foregroundActivity: () => {
      const token = {};
      const activity = { account: input.accountId(), busy: true };
      foreground.set(token, activity);
      return {
        setBusy: (busy) => {
          activity.busy = busy;
          for (const notify of idleListeners) notify();
        },
        dispose: () => {
          foreground.delete(token);
          for (const notify of idleListeners) notify();
        },
      };
    },
    awaitForegroundIdle: Effect.callback<void>((resume) => {
      const account = input.accountId();
      const check = () => {
        if (!isForegroundBusy(account)) {
          idleListeners.delete(check);
          resume(Effect.void);
        }
      };
      idleListeners.add(check);
      check();
      return Effect.sync(() => {
        idleListeners.delete(check);
      });
    }),
    backgroundPrefetchAllowed: Effect.promise(async () => {
      const account = input.accountId();
      if (
        [...foreground.values()].some((activity) => activity.account === account && activity.busy)
      )
        return false;
      return input.unmetered?.().catch(() => false) ?? false;
    }),
    prefetchAllowed: Effect.promise(
      () => input.unmetered?.().catch(() => false) ?? Promise.resolve(false),
    ),
    inspectHistoryCache: run("load-thread", async (state) => ({
      budgetBytes: state.index.budget,
      entries: state.index.entries.map((entry) => ({
        environmentId: EnvironmentId.make(entry.environmentId),
        kind: entry.kind,
        bytes: entry.bytes,
      })),
    })),
    clearHistoryCache: run("remove-thread", async (state) => {
      for (const entry of state.index.entries) await state.storage.remove(entry.key);
      state.index = { ...state.index, entries: [] };
      await persistIndex(state);
    }),
    setHistoryCacheBudget: (bytes) =>
      run("save-thread", async (state, account) => {
        if (!Number.isSafeInteger(bytes) || bytes < 16 * 1024 ** 2)
          throw new Error("Cache budget must be at least 16 MiB.");
        state.index = { ...state.index, budget: bytes };
        await trim(state, account);
      }),
    removeThread: (environmentId, threadId) =>
      remove(environmentId, threadId).pipe(
        Effect.andThen(input.base.removeThread(environmentId, threadId)),
      ),
    clear: (environmentId) =>
      remove(environmentId).pipe(Effect.andThen(input.base.clear(environmentId))),
  });
}
