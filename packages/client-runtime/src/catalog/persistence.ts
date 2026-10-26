import { MinesCatalog, mergeCatalogUpdates, catalogStateVectorIncludes } from "./index.ts";

/** Platform storage encrypts snapshots; keys live in the platform credential store. */
export interface EncryptedCatalogStorage {
  read(): Promise<Uint8Array | null>;
  write(snapshot: Uint8Array): Promise<void | Uint8Array>;
  clear(): Promise<void>;
  subscribe?(
    listener: (snapshot: Uint8Array) => void,
    onError: (error: unknown) => void,
  ): () => void;
  close?(): void;
}

export function createAtomicCatalogStorage(
  storage: EncryptedCatalogStorage,
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
): EncryptedCatalogStorage {
  return {
    ...storage,
    write: (snapshot) =>
      exclusive(async () => {
        const previous = await storage.read();
        const merged = mergeCatalogUpdates(previous ? [previous, snapshot] : [snapshot]);
        return (await storage.write(merged)) ?? merged;
      }),
    clear: () => exclusive(() => storage.clear()),
  };
}

export async function openPersistedCatalog(options: {
  storage: EncryptedCatalogStorage;
  createId?: () => string;
  onPersistenceError?: (error: unknown) => void;
}) {
  const catalog = new MinesCatalog(options.createId ? { createId: options.createId } : {});
  const stored = await options.storage.read();
  if (stored) catalog.applyUpdate(stored, "catalog-storage");
  let persistenceError: string | null = null;
  const errorListeners = new Set<() => void>();
  const setError = (error: unknown | null) => {
    persistenceError =
      error === null
        ? null
        : error instanceof Error
          ? error.message
          : "The sidebar could not be saved on this device.";
    for (const listener of errorListeners) listener();
  };
  let pending: Uint8Array | null = null;
  let writing: Promise<void> | null = null;
  const drain = async () => {
    while (pending !== null) {
      const snapshot = pending;
      pending = null;
      try {
        const merged = await options.storage.write(snapshot);
        if (merged) catalog.applyUpdate(merged, "catalog-storage");
        setError(null);
      } catch (error) {
        pending ??= snapshot;
        setError(error);
        throw error;
      }
    }
  };
  const startWriting = () => {
    if (writing !== null || pending === null) return;
    writing = drain()
      .catch((error: unknown) => {
        options.onPersistenceError?.(error);
        throw error;
      })
      .finally(() => {
        writing = null;
        if (persistenceError === null) startWriting();
      });
    // UI stays usable if local storage fills; callers can surface the persistence error.
    void writing.catch(() => {});
  };
  const save = () => {
    pending = catalog.encodeUpdate();
    startWriting();
  };
  const flush = async () => {
    let active = writing;
    while (active !== null) {
      await active;
      active = writing;
    }
    if (persistenceError) throw new Error(persistenceError);
  };
  const unsubscribe = catalog.subscribeUpdates((_update, origin) => {
    if (origin !== "catalog-storage") save();
  });
  const unsubscribeStorage = options.storage.subscribe?.(
    (snapshot) => catalog.applyUpdate(snapshot, "catalog-storage"),
    setError,
  );
  return {
    catalog,
    getPersistenceError: () => persistenceError,
    subscribePersistence: (listener: () => void) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    flush,
    close: async () => {
      unsubscribe();
      unsubscribeStorage?.();
      try {
        await flush();
      } finally {
        catalog.destroy();
        options.storage.close?.();
      }
    },
  };
}

export interface CatalogPeerChannel {
  send(data: Uint8Array): Promise<void>;
  subscribe(listener: (data: Uint8Array) => void): () => void;
}

export function connectCatalogPeer(
  catalog: MinesCatalog,
  peer: CatalogPeerChannel,
  options: {
    onStatus?: (status: "syncing" | "synced" | "error") => void;
    onError?: (error: unknown) => void;
  } = {},
) {
  const origin = Symbol("catalog-peer");
  let closed = false;
  let inFlight = Promise.resolve();
  let acknowledged: Uint8Array | undefined;
  let failure: unknown;
  const waiting = new Set<{
    vector: Uint8Array;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  const fail = (error: unknown) => {
    failure = error;
    for (const pending of waiting) pending.reject(error);
    waiting.clear();
    options.onStatus?.("error");
    options.onError?.(error);
  };
  const send = (type: number, data: Uint8Array) => {
    const frame = new Uint8Array(data.byteLength + 1);
    frame[0] = type;
    frame.set(data, 1);
    inFlight = inFlight.then(() => (closed ? undefined : peer.send(frame))).catch(fail);
  };
  const unsubscribe = peer.subscribe((frame) => {
    if (closed) return;
    try {
      if (frame.byteLength < 2 || frame.byteLength > 8 * 1024 * 1024)
        throw new Error("Invalid catalog frame size.");
      const payload = frame.subarray(1);
      switch (frame[0]) {
        case 0:
          send(1, catalog.encodeUpdate(payload));
          break;
        case 1:
          catalog.applyUpdate(payload, origin);
          send(2, catalog.encodeStateVector());
          break;
        case 2: {
          acknowledged = payload.slice();
          for (const pending of waiting) {
            if (!catalogStateVectorIncludes(payload, pending.vector)) continue;
            waiting.delete(pending);
            pending.resolve();
          }
          const local = catalog.encodeStateVector();
          const equal =
            local.length === payload.length &&
            local.every((value, index) => value === payload[index]);
          options.onStatus?.(equal ? "synced" : "syncing");
          if (!equal) send(0, local);
          break;
        }
        default:
          throw new Error("Unsupported catalog frame.");
      }
    } catch (error) {
      fail(error);
    }
  });
  const stopUpdates = catalog.subscribeUpdates((update, updateOrigin) => {
    if (updateOrigin === origin) return;
    options.onStatus?.("syncing");
    send(1, update);
  });
  options.onStatus?.("syncing");
  send(0, catalog.encodeStateVector());
  const stop = () => {
    closed = true;
    unsubscribe();
    stopUpdates();
    for (const pending of waiting) pending.reject(new Error("Catalog connection closed."));
    waiting.clear();
  };
  const flush = (vector: Uint8Array, signal?: AbortSignal): Promise<void> => {
    if (closed || failure || signal?.aborted)
      return Promise.reject(failure ?? new Error("Catalog connection is unavailable."));
    if (!catalogStateVectorIncludes(catalog.encodeStateVector(), vector))
      return Promise.reject(new Error("This device has not received the requested context."));
    if (acknowledged && catalogStateVectorIncludes(acknowledged, vector)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        waiting.delete(pending);
        reject(new Error("Context synchronization was interrupted."));
      };
      const finish = (action: () => void) => {
        signal?.removeEventListener("abort", abort);
        action();
      };
      const pending = {
        vector: vector.slice(),
        resolve: () => finish(resolve),
        reject: (error: unknown) => finish(() => reject(error)),
      };
      waiting.add(pending);
      signal?.addEventListener("abort", abort, { once: true });
      send(1, catalog.encodeUpdate(acknowledged));
    });
  };
  return Object.assign(stop, { flush });
}
