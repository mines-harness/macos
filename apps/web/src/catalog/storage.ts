import {
  createAtomicCatalogStorage,
  type EncryptedCatalogStorage,
} from "@t3tools/client-runtime/catalog/persistence";

const DATABASE = "mines-private-catalog-v1";

function request<T>(operation: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    operation.addEventListener("success", () => resolve(operation.result), { once: true });
    operation.addEventListener(
      "error",
      () => reject(operation.error ?? new Error("Could not access local sidebar storage.")),
      { once: true },
    );
  });
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    const failed = () => reject(transaction.error ?? new Error("Could not save the sidebar."));
    transaction.addEventListener("abort", failed, { once: true });
    transaction.addEventListener("error", failed, { once: true });
  });
}

export async function createBrowserCatalogStorage(
  accountId: string,
): Promise<EncryptedCatalogStorage> {
  const locks = globalThis.navigator?.locks;
  const bridge = window.desktopBridge;
  if (!(bridge?.getMinesCatalog && bridge.setMinesCatalog && bridge.clearMinesCatalog) && !locks)
    throw new Error(
      "This browser cannot safely save a library shared by multiple windows. Use a browser with Web Locks or the mines desktop app.",
    );
  const store = await openBrowserPrivateStore(accountId);
  const base = {
    read: () => store.read("catalog"),
    write: (value: Uint8Array) => store.write("catalog", value),
    clear: () => store.remove("catalog"),
  };
  const storage: EncryptedCatalogStorage = store.mergeCatalog
    ? { ...base, write: store.mergeCatalog }
    : createAtomicCatalogStorage(base, (operation) =>
        locks!.request(`mines-catalog:${accountId}`, operation),
      );
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(`mines-catalog:${accountId}`);
  return {
    ...storage,
    write: async (snapshot) => {
      const merged = await storage.write(snapshot);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin argument.
      channel?.postMessage("changed");
      return merged;
    },
    subscribe: (listener, onError) => {
      let closed = false;
      const reload = () => {
        void storage
          .read()
          .then((snapshot) => {
            if (!closed && snapshot) listener(snapshot);
          })
          .catch((error: unknown) => {
            if (!closed) onError(error);
          });
      };
      channel?.addEventListener("message", reload);
      reload();
      return () => {
        closed = true;
        channel?.removeEventListener("message", reload);
      };
    },
    close: () => channel?.close(),
  };
}

const stores = new Map<string, Promise<BrowserPrivateStore>>();
interface BrowserPrivateStore {
  read(recordId: string): Promise<Uint8Array | null>;
  write(recordId: string, value: Uint8Array): Promise<void>;
  remove(recordId: string): Promise<void>;
  mergeCatalog?(snapshot: Uint8Array): Promise<Uint8Array>;
}
export function openBrowserPrivateStore(accountId: string): Promise<BrowserPrivateStore> {
  const existing = stores.get(accountId);
  if (existing) return existing;
  const opening = createBrowserPrivateStore(accountId);
  stores.set(accountId, opening);
  void opening.catch(() => stores.delete(accountId));
  return opening;
}
async function createBrowserPrivateStore(accountId: string): Promise<BrowserPrivateStore> {
  const bridge = window.desktopBridge;
  if (bridge?.getMinesCatalog && bridge.setMinesCatalog && bridge.clearMinesCatalog) {
    const { getMinesCatalog, setMinesCatalog, clearMinesCatalog } = bridge;
    const keyFor = async (recordId: string) => {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([accountId, recordId])),
      );
      return `private_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    return {
      async read(recordId) {
        const snapshot = await getMinesCatalog(await keyFor(recordId));
        return snapshot === null
          ? null
          : Uint8Array.from(atob(snapshot), (char) => char.charCodeAt(0));
      },
      async write(recordId, snapshot) {
        let binary = "";
        for (const byte of snapshot) binary += String.fromCharCode(byte);
        await setMinesCatalog(await keyFor(recordId), btoa(binary));
      },
      mergeCatalog: async (snapshot) => {
        let binary = "";
        for (const byte of snapshot) binary += String.fromCharCode(byte);
        const merged = await setMinesCatalog(await keyFor("catalog"), btoa(binary), true);
        if (typeof merged !== "string")
          throw new Error("Update the desktop app to save your library safely.");
        return Uint8Array.from(atob(merged), (character) => character.charCodeAt(0));
      },
      remove: async (recordId) => clearMinesCatalog(await keyFor(recordId)),
    };
  }
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB)
    throw new Error("Encrypted local storage is unavailable in this browser.");
  const opening = indexedDB.open(DATABASE, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore("keys");
    opening.result.createObjectStore("snapshots");
  };
  const database = await request(opening);
  const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const keyTransaction = database.transaction("keys", "readwrite");
  const keyDone = complete(keyTransaction);
  const keys = keyTransaction.objectStore("keys");
  const existing: unknown = await request(keys.get(accountId));
  const key = existing instanceof CryptoKey ? existing : candidate;
  if (!(existing instanceof CryptoKey)) keys.put(candidate, accountId);
  await keyDone;
  const storageKey = (recordId: string) => JSON.stringify([accountId, recordId]);
  const aad = (recordId: string) =>
    new TextEncoder().encode(`mines.private.v1:${storageKey(recordId)}`);
  return {
    async read(recordId) {
      const transaction = database.transaction("snapshots", "readonly");
      const stored: unknown = await request(
        transaction.objectStore("snapshots").get(storageKey(recordId)),
      );
      if (stored === undefined) return null;
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("iv" in stored) ||
        !("data" in stored) ||
        !(stored.iv instanceof Uint8Array) ||
        !(stored.data instanceof ArrayBuffer)
      ) {
        throw new Error("The encrypted sidebar cache is invalid.");
      }
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(stored.iv), additionalData: aad(recordId) },
        key,
        stored.data,
      );
      return new Uint8Array(decrypted);
    },
    async write(recordId, snapshot) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(recordId) },
        key,
        new Uint8Array(snapshot).buffer,
      );
      const transaction = database.transaction("snapshots", "readwrite");
      const done = complete(transaction);
      transaction.objectStore("snapshots").put({ iv, data }, storageKey(recordId));
      await done;
    },
    async remove(recordId) {
      const transaction = database.transaction("snapshots", "readwrite");
      const done = complete(transaction);
      transaction.objectStore("snapshots").delete(storageKey(recordId));
      await done;
    },
  };
}
