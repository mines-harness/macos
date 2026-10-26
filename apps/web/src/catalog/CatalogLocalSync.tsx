import { useStableCallback } from "../hooks/useStableCallback";
import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { MinesCatalog } from "@t3tools/client-runtime/catalog";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { connectionAtomRuntime } from "../connection/runtime";
import { usePreparedConnection } from "../state/session";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { bindCatalogIdentity } from "../state/catalogIdentity";
import {
  minesCatalogIdentityAtom,
  registerCatalogExecutionHost,
  catalogStateVectorIncludes,
  catalogBytesToBase64 as encode,
  catalogBytesFromBase64 as decode,
} from "@t3tools/client-runtime/catalog";

const exchangeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:catalog:exchange",
  tag: WS_METHODS.catalogExchange,
});
const subscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mines:catalog:subscribe",
  tag: WS_METHODS.catalogSubscribe,
  idleTtlMs: 0,
});
/** The RPC bridge is restricted to the renderer's loopback host. Remote copies use DTLS. */
export function CatalogLocalSync({
  catalog,
  accountId,
  environmentId,
}: {
  catalog: MinesCatalog;
  accountId: string;
  environmentId: EnvironmentId;
}) {
  const prepared = usePreparedConnection(environmentId);
  const connection = Option.getOrNull(prepared);
  let local = false;
  if (connection && !connection.peerSession) {
    try {
      local = ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connection.httpBaseUrl).hostname,
      );
    } catch {
      /* No usable local host. */
    }
  }
  return local ? (
    <LocalHostSync catalog={catalog} accountId={accountId} environmentId={environmentId} />
  ) : null;
}
function LocalHostSync({
  catalog,
  accountId,
  environmentId,
}: {
  catalog: MinesCatalog;
  accountId: string;
  environmentId: EnvironmentId;
}) {
  const identity = useAtomValue(minesCatalogIdentityAtom);
  const allowed = identity.ready && (identity.accountId ?? "local-device") === accountId;
  const [boundIdentity, setBoundIdentity] = useState<typeof identity | null>(null);
  const bind = useAtomCommand(bindCatalogIdentity, { reportFailure: false });
  const runBind = useStableCallback(bind);
  const updates = useEnvironmentQuery(
    allowed && boundIdentity === identity
      ? subscription({ environmentId, input: { accountId } })
      : null,
  );
  const exchange = useAtomCommand(exchangeCommand, { reportFailure: false });
  const runExchange = useStableCallback(exchange);
  const reconcile = useRef<(() => void) | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    let closed = false;
    let running = false;
    let dirty = false;
    let remoteVector: Uint8Array | undefined;
    let bound = false;
    let queue = Promise.resolve();
    const assertCurrent = (signal?: AbortSignal) => {
      const current = appAtomRegistry.get(minesCatalogIdentityAtom);
      if (
        closed ||
        signal?.aborted ||
        !current.ready ||
        (current.accountId ?? "local-device") !== accountId
      )
        throw new Error(
          "Your account changed before project context could synchronize. Send again after reconnecting.",
        );
    };
    const synchronize = (required: Uint8Array, signal?: AbortSignal) => {
      const operation = queue.then(async () => {
        assertCurrent(signal);
        if (!bound) {
          const current = appAtomRegistry.get(minesCatalogIdentityAtom);
          const bearerToken = current.readToken ? await current.readToken() : null;
          assertCurrent(signal);
          if (current.accountId && !bearerToken)
            throw new Error("Sign in again before synchronizing your project context.");
          const result = await runBind({ environmentId, input: { bearerToken } });
          assertCurrent(signal);
          if (result._tag !== "Success" || (result.value.accountId ?? "local-device") !== accountId)
            throw new Error("This computer could not verify your account for project context.");
          bound = true;
          setBoundIdentity(identity);
        }
        const result = await runExchange({
          environmentId,
          input: {
            accountId,
            stateVector: encode(catalog.encodeStateVector()),
            update: encode(catalog.encodeUpdate(remoteVector)),
          },
        });
        assertCurrent(signal);
        if (result._tag !== "Success")
          throw new Error(
            "Project context has not synchronized with this computer. Wait for synchronization, then send again.",
          );
        const acknowledged = decode(result.value.stateVector);
        if (!catalogStateVectorIncludes(acknowledged, required))
          throw new Error(
            "This computer has not acknowledged the latest project context. Try again shortly.",
          );
        remoteVector = acknowledged;
        catalog.applyUpdate(decode(result.value.update), "local-host");
        setError(false);
      });
      queue = operation.catch(() => {});
      return operation;
    };
    const unregister = registerCatalogExecutionHost(
      appAtomRegistry,
      environmentId,
      async (capture, signal) => {
        if (capture.accountId !== accountId || capture.catalog !== catalog)
          throw new Error("Project context belongs to a different account.");
        try {
          await synchronize(capture.stateVector, signal);
        } catch (error) {
          setError(true);
          throw error;
        }
      },
    );
    const pump = async () => {
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty) {
          if (closed) return;
          dirty = false;
          try {
            await synchronize(catalog.encodeStateVector().slice());
          } catch {
            if (!closed) setError(true);
            return;
          }
        }
      } finally {
        running = false;
      }
    };
    reconcile.current = () => {
      void pump();
    };
    const stop = catalog.subscribeUpdates((_update, origin) => {
      if (origin !== "local-host") void pump();
    });
    void pump();
    return () => {
      closed = true;
      stop();
      unregister();
      reconcile.current = null;
    };
  }, [allowed, catalog, accountId, environmentId, identity, runBind, runExchange]);
  useEffect(() => {
    if (updates.data) reconcile.current?.();
  }, [updates.data]);
  return error || updates.error ? (
    <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
      Sidebar changes are saved here. Waiting to sync with this computer.
    </p>
  ) : null;
}
