import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import type { MinesCatalog } from "./index.ts";
import { connectCatalogPeer } from "./persistence.ts";

const owners = new WeakMap<PeerSession, string>();
const bindings = new WeakMap<
  PeerSession,
  { catalog: MinesCatalog; users: number; stop: ReturnType<typeof connectCatalogPeer> }
>();
const bindingListeners = new WeakMap<PeerSession, Set<() => void>>();

export async function flushCatalogSession(
  session: PeerSession,
  accountId: string,
  requiredVector: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (!bindings.has(session)) {
    await new Promise<void>((resolve, reject) => {
      const listeners = bindingListeners.get(session) ?? new Set<() => void>();
      bindingListeners.set(session, listeners);
      const cleanup = () => {
        listeners.delete(ready);
        signal?.removeEventListener("abort", abort);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(new Error("Context synchronization was interrupted."));
      };
      listeners.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
      void session.closed.then(abort);
      if (signal?.aborted) abort();
    });
  }
  const binding = bindings.get(session);
  if (!binding || owners.get(session) !== accountId)
    throw new Error("The context belongs to a different signed-in account.");
  await binding.stop.flush(requiredVector, signal);
}

/** Call only for authenticated, approved sessions. A session never crosses account boundaries. */
export function bindCatalogSession(catalog: MinesCatalog, accountId: string, session: PeerSession) {
  const previousOwner = owners.get(session);
  if (previousOwner !== undefined && previousOwner !== accountId) {
    session.close();
    return () => {};
  }
  if (accountId === "local-device") return () => {};
  owners.set(session, accountId);
  let binding = bindings.get(session);
  if (binding && binding.catalog !== catalog) {
    session.close();
    return () => {};
  }
  if (!binding) {
    const stop = connectCatalogPeer(
      catalog,
      {
        send: (data) => session.send("catalog", data),
        subscribe: (listener) => session.subscribe("catalog", listener),
      },
      { onError: () => session.close() },
    );
    binding = { catalog, users: 0, stop };
    bindings.set(session, binding);
    for (const ready of bindingListeners.get(session) ?? []) ready();
    void session.closed.then(() => {
      stop();
      bindings.delete(session);
    });
  }
  binding.users += 1;
  const current = binding;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.users -= 1;
    if (current.users === 0) {
      current.stop();
      bindings.delete(session);
    }
  };
}
