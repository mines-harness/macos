import { useMinesAuth } from "./MinesAuthProvider";
import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
  minesCatalogIdentityAtom,
} from "@t3tools/client-runtime/catalog";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { restorePeerClient } from "../connection/peerOnboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentsWithScope,
} from "../state/session";
import { bindCatalogIdentity } from "../state/catalogIdentity";
import { peerConfigure } from "../state/peers";
import { toastManager } from "../components/ui/toast";
import { isLocalMinesAccountHost } from "./minesAccountHosts";
import { minesControlUrl } from "./publicConfig";
import { minesDeviceSyncPreferences } from "./minesDeviceSyncPreference";

export function MinesIdentityBridge({ children }: { readonly children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken } = useMinesAuth();
  const accountId = isLoaded && isSignedIn ? (userId ?? null) : null;
  const { environments } = useEnvironments();
  const allowed = useEnvironmentsWithScope(environments, AuthAccessWriteScope);
  const hostIdsKey = environments
    .filter(
      ({ environmentId, connection }) =>
        connection.phase === "connected" &&
        allowed.has(environmentId) &&
        isLocalMinesAccountHost(readPreparedConnection(environmentId)),
    )
    .map(({ environmentId }) => environmentId)
    .sort()
    .join("\n");
  const transition = useRef(Promise.resolve());
  const previousAccount = useRef<string | null | undefined>(undefined);
  const previousHosts = useRef<ReadonlyArray<EnvironmentId>>([]);
  useLayoutEffect(() => {
    let active = true;
    appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set());
    appAtomRegistry.set(minesAccountIdAtom, null);
    appAtomRegistry.set(minesCatalogIdentityAtom, {
      ready: false,
      accountId: null,
      readToken: null,
    });
    if (isLoaded) {
      const hostIds = hostIdsKey ? hostIdsKey.split("\n").map((id) => EnvironmentId.make(id)) : [];
      const bind = async (environmentId: EnvironmentId, bearerToken: string | null) => {
        if (
          !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
          !isLocalMinesAccountHost(readPreparedConnection(environmentId))
        ) {
          throw new Error("The local computer is unavailable for this account change.");
        }
        const result = await runAtomCommand(
          appAtomRegistry,
          bindCatalogIdentity,
          {
            environmentId,
            input: { bearerToken },
          },
          { reportFailure: false },
        );
        if (!AsyncResult.isSuccess(result)) throw squashAtomCommandFailure(result);
        return result.value;
      };
      transition.current = transition.current
        .catch(() => {})
        .then(async () => {
          let cleanupFailed = false;
          if (previousAccount.current !== accountId || accountId === null) {
            const cleaned = await Promise.allSettled(
              [...new Set([...previousHosts.current, ...hostIds])].map((environmentId) =>
                bind(environmentId, null),
              ),
            );
            cleanupFailed = cleaned.some((result) => result.status === "rejected");
          }
          const result = await runAtomCommand(
            appAtomRegistry,
            restorePeerClient,
            cleanupFailed ? null : accountId,
            {
              reportFailure: false,
            },
          );
          if (cleanupFailed)
            throw new Error(
              "Some local computers could not finish signing out. Reconnect them and try again.",
            );
          previousAccount.current = accountId;
          previousHosts.current = hostIds;
          if (active && AsyncResult.isSuccess(result)) {
            if (accountId) {
              const token = await getToken();
              if (!active) return;
              if (!token) throw new Error("Sign in again to enable device sync.");
              for (const environmentId of hostIds) {
                if (!active) return;
                const binding = await bind(environmentId, token);
                if (!active) return;
                if (binding.accountId !== accountId)
                  throw new Error("Your account changed before device sync could start.");
                const controlUrl = minesControlUrl();
                if (!controlUrl) continue;
                if (
                  !minesDeviceSyncPreferences.canAutoEnable({
                    accountId,
                    environmentId,
                    controlUrl,
                  })
                )
                  continue;
                if (
                  !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
                  !isLocalMinesAccountHost(readPreparedConnection(environmentId))
                ) {
                  throw new Error("The local computer changed before device sync could start.");
                }
                const stunUrl = (import.meta.env.VITE_MINES_STUN_URL as string | undefined)?.trim();
                const configured = await runAtomCommand(
                  appAtomRegistry,
                  peerConfigure,
                  {
                    environmentId,
                    input: {
                      controlUrl,
                      bearerToken: token,
                      stunServers: stunUrl ? [stunUrl] : [],
                    },
                  },
                  { reportFailure: false },
                );
                if (!AsyncResult.isSuccess(configured)) {
                  toastManager.add({
                    type: "error",
                    title: "Device sync could not start",
                    description: "Open Settings → Connections to reconnect this computer.",
                  });
                }
              }
            }
            if (!active) return;
            appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set(result.value));
            appAtomRegistry.set(minesAccountIdAtom, accountId);
            appAtomRegistry.set(minesCatalogIdentityAtom, {
              ready: true,
              accountId,
              readToken: accountId ? () => getToken() : null,
            });
          }
        })
        .catch(() => {
          if (active)
            toastManager.add({
              type: "error",
              title: "Account connection needs attention",
              description: "Open Settings → Connections to reconnect your Mines account.",
            });
        });
    }
    return () => {
      active = false;
      appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set());
      appAtomRegistry.set(minesAccountIdAtom, null);
      appAtomRegistry.set(minesCatalogIdentityAtom, {
        ready: false,
        accountId: null,
        readToken: null,
      });
      transition.current = transition.current
        .catch(() => {})
        .then(async () => {
          await runAtomCommand(appAtomRegistry, restorePeerClient, null, { reportFailure: false });
        });
    };
  }, [accountId, getToken, isLoaded, hostIdsKey]);
  return children;
}
