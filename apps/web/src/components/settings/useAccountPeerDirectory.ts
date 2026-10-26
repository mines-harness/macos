import type { PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";
import { getPeerDevices } from "@t3tools/shared/minesPeerSignaling";
import { useEffect, useState } from "react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { minesControlUrl } from "../../cloud/publicConfig";

export function useAccountPeerDirectory() {
  const { isSignedIn, userId, getToken } = useMinesAuth();
  const accountId = isSignedIn ? userId : null;
  const controlUrl = minesControlUrl();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    readonly accountId: string | null;
    readonly data: PeerDeviceDirectory | null;
    readonly requestKey: string;
    readonly error: string | null;
  }>({ accountId: null, data: null, requestKey: "", error: null });
  const requestKey = JSON.stringify([accountId, controlUrl, revision]);

  useEffect(() => {
    if (!accountId || !controlUrl) return;
    let active = true;
    void getPeerDevices({
      controlUrl,
      bearerToken: async () => {
        const token = await getToken();
        if (!active || !token) throw new Error("Sign in to Mines to see your devices.");
        return token;
      },
    }).then(
      (data) => {
        if (active) setState({ accountId, data, requestKey, error: null });
      },
      () => {
        if (active)
          setState({
            accountId,
            data: null,
            requestKey,
            error: "Device presence could not be loaded. Check your connection or sign in again.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [accountId, controlUrl, getToken, requestKey]);

  const current = state.accountId === accountId && state.requestKey === requestKey ? state : null;
  return {
    data: current?.data ?? null,
    isPending: accountId !== null && controlUrl !== null && current === null,
    error: current?.error ?? null,
    refresh: () => setRevision((value) => value + 1),
  };
}
