import * as Schema from "effect/Schema";
import type { MobilePrivateStore } from "./encryptedStorage";

const Draft = Schema.Struct({
  text: Schema.String,
  requestId: Schema.String,
  attempted: Schema.Boolean,
});
type Draft = typeof Draft.Type;
const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Draft));

export async function openGroupDraft(input: {
  storage: Pick<MobilePrivateStore, "read" | "write">;
  environmentId: string;
  groupId: string;
  createId: () => string;
}) {
  const recordId = `group-draft:${JSON.stringify([input.environmentId, input.groupId])}`;
  const stored = await input.storage.read(recordId);
  let snapshot: { draft: Draft; error: string | null } = {
    draft: stored
      ? decodeDraft(new TextDecoder().decode(stored))
      : {
          text: "",
          requestId: input.createId(),
          attempted: false,
        },
    error: null,
  };
  const listeners = new Set<() => void>();
  let pending: Promise<void> = Promise.resolve();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const persist = (draft: Draft) => {
    snapshot = { draft, error: null };
    notify();
    pending = pending
      .catch(() => {})
      .then(async () => {
        try {
          await input.storage.write(recordId, new TextEncoder().encode(JSON.stringify(draft)));
          if (snapshot.draft === draft) snapshot = { draft, error: null };
        } catch (error) {
          snapshot = {
            ...snapshot,
            error:
              error instanceof Error ? error.message : "Could not save your draft on this phone.",
          };
          throw error;
        } finally {
          notify();
        }
      });
    void pending.catch(() => {});
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setText: (value: string | ((current: string) => string)) => {
      const text = typeof value === "function" ? value(snapshot.draft.text) : value;
      if (text === snapshot.draft.text) return;
      persist({ text, requestId: input.createId(), attempted: false });
    },
    markAttempted: () => {
      const draft = { ...snapshot.draft, attempted: true };
      persist(draft);
      return draft;
    },
    acknowledge: (requestId: string) => {
      if (snapshot.draft.requestId === requestId)
        persist({ text: "", requestId: input.createId(), attempted: false });
    },
    clear: () => persist({ text: "", requestId: input.createId(), attempted: false }),
    flush: async () => {
      let active = pending;
      for (;;) {
        await active;
        if (active === pending) return;
        active = pending;
      }
    },
  };
}
