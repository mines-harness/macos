import { useAtomValue } from "@effect/atom-react";
import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import { useEffect, useState, useSyncExternalStore } from "react";
import { uuidv4 } from "../lib/uuid";
import { openMobilePrivateStore } from "./encryptedStorage";
import { openGroupDraft } from "./groupDraft";

type DraftStore = Awaited<ReturnType<typeof openGroupDraft>>;
const stores = new Map<string, Promise<DraftStore>>();
const noSubscribe = () => () => {};
const empty = { draft: { text: "", requestId: "", attempted: false }, error: null };
const getEmpty = () => empty;

export function useGroupDraft(environmentId: string, groupId: string) {
  const accountId = useAtomValue(minesAccountIdAtom) ?? "local-device";
  const key = JSON.stringify([accountId, environmentId, groupId]);
  const [state, setState] = useState<{ key: string; store?: DraftStore; error?: string }>({ key });
  useEffect(() => {
    let closed = false;
    let pending = stores.get(key);
    if (!pending) {
      pending = openMobilePrivateStore(accountId).then((storage) =>
        openGroupDraft({ storage, environmentId, groupId, createId: uuidv4 }),
      );
      stores.set(key, pending);
      void pending.catch(() => stores.delete(key));
    }
    void pending
      .then((store) => {
        if (!closed) setState({ key, store });
      })
      .catch((error: unknown) => {
        if (!closed)
          setState({
            key,
            error: error instanceof Error ? error.message : "Could not open the saved draft.",
          });
      });
    return () => {
      closed = true;
    };
  }, [key, accountId, environmentId, groupId]);
  const store = state.key === key ? state.store : undefined;
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? getEmpty,
    getEmpty,
  );
  return {
    store,
    draft: snapshot.draft,
    error: snapshot.error ?? (state.key === key ? state.error : null),
  };
}
