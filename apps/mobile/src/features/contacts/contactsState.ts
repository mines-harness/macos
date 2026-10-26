import type { ContactsSnapshot } from "@t3tools/contracts/contacts";
import {
  createContactsClient,
  type ContactsClient,
  type ContactsClientOptions,
} from "@t3tools/shared/minesContacts";

export interface MobileContactsSnapshot {
  readonly data: ContactsSnapshot | null;
  readonly pending: boolean;
  readonly error: string | null;
}

export function createMobileContactsState(options: ContactsClientOptions) {
  let active = true;
  let revision = 0;
  let mutating = false;
  let snapshot: MobileContactsSnapshot = { data: null, pending: false, error: null };
  const listeners = new Set<() => void>();
  const client = createContactsClient({
    ...options,
    isCurrent: () => active && options.isCurrent?.() !== false,
  });
  const publish = (next: MobileContactsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const execute = async (
    operation: (client: ContactsClient) => Promise<ContactsSnapshot>,
    mutation: boolean,
  ) => {
    if (!active || mutating) return false;
    const expected = ++revision;
    if (mutation) mutating = true;
    publish({ ...snapshot, pending: true, error: null });
    try {
      const data = await operation(client);
      if (!active || expected !== revision) return false;
      publish({ data, pending: false, error: null });
      return true;
    } catch (cause) {
      if (active && expected === revision)
        publish({
          ...snapshot,
          pending: false,
          error: cause instanceof Error ? cause.message : "Contacts could not be loaded.",
        });
      return false;
    } finally {
      if (mutation) mutating = false;
    }
  };
  return {
    activate: () => {
      active = true;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => execute((client) => client.snapshot(), false),
    run: (operation: (client: ContactsClient) => Promise<ContactsSnapshot>) =>
      execute(operation, true),
    dispose: () => {
      active = false;
      revision += 1;
      listeners.clear();
    },
  };
}
