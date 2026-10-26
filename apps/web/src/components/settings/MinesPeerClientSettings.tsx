import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { decodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironments } from "../../state/environments";
import {
  forgetPeerClient,
  pairPeerClient,
  peerClientApproval,
  peerClientRoutes,
} from "../../connection/peerOnboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useMinesAuthPrompt } from "../clerk/useMinesAuthPrompt";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import type { EnvironmentId } from "@t3tools/contracts";
import { peerClientConnectionStatus } from "./peerClientStatus.logic";

export function MinesPeerClientSettings() {
  if (!hasMinesIdentityConfig()) return null;
  return <PeerClientContent />;
}
function PeerClientContent() {
  const { userId } = useMinesAuth();
  return <PeerClientAccountContent key={userId ?? "signed-out"} />;
}
function PeerClientAccountContent() {
  const { userId, isSignedIn, getToken } = useMinesAuth();
  const { openAuthPrompt } = useMinesAuthPrompt();
  const approval = useAtomCommand(peerClientApproval, { reportFailure: false });
  const list = useAtomCommand(peerClientRoutes, { reportFailure: false });
  const pair = useAtomCommand(pairPeerClient, { reportFailure: false });
  const forget = useAtomCommand(forgetPeerClient, { reportFailure: false });
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [code, setCode] = useState<{ code: string; fingerprint: string } | null>(null);
  const [routes, setRoutes] = useState<
    readonly { environmentId: EnvironmentId; host: { label: string; deviceId: string } }[]
  >([]);
  const [pairing, setPairing] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<EnvironmentId | null>(null);
  const nowMs = useRelativeTimeTick(15_000);
  const loadAccount = useEffectEvent((accountId: string, active: () => boolean) => {
    void approval(accountId).then((result) => {
      if (!active()) return;
      if (AsyncResult.isSuccess(result))
        setCode({ code: result.value.code, fingerprint: result.value.device.deviceId });
      else setError("The device key could not be opened. Unlock this computer and try again.");
    });
    void list(accountId).then((result) => {
      if (active() && AsyncResult.isSuccess(result)) setRoutes(result.value);
    });
  });
  useEffect(() => {
    let active = true;
    if (!isSignedIn || !userId) return;
    loadAccount(userId, () => active);
    return () => {
      active = false;
    };
  }, [userId, isSignedIn]);
  let target: ReturnType<typeof decodePeerPairing> | null = null;
  let invalid: string | null = null;
  if (pairing.trim()) {
    try {
      target = decodePeerPairing(pairing, nowMs / 1000);
    } catch (cause) {
      invalid = cause instanceof Error ? cause.message : "Invalid pairing link.";
    }
  }
  const connect = async () => {
    if (!userId || !isSignedIn || !target || busy) return;
    setBusy(true);
    setError(null);
    const result = await pair({
      accountId: userId,
      pairingUrl: pairing,
      getToken,
    });
    if (AsyncResult.isSuccess(result)) {
      setPairing("");
      const latest = await list(userId);
      if (AsyncResult.isSuccess(latest)) setRoutes(latest.value);
    } else setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const disconnect = async (environmentId: EnvironmentId) => {
    if (!userId || busy) return;
    setBusy(true);
    setError(null);
    const result = await forget({ accountId: userId, environmentId });
    if (AsyncResult.isSuccess(result))
      setRoutes((current) => current.filter((route) => route.environmentId !== environmentId));
    else setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const refresh = async () => {
    if (!userId || !isSignedIn || busy) return;
    setBusy(true);
    setError(null);
    const result = await list(userId);
    if (AsyncResult.isSuccess(result)) setRoutes(result.value);
    else setError(String(squashAtomCommandFailure(result)));
    setBusy(false);
  };
  const check = async (environmentId: EnvironmentId) => {
    if (!userId || !isSignedIn || busy || checking !== null) return;
    const environment = environmentById.get(environmentId);
    if (!environment || !routes.some((route) => route.environmentId === environmentId)) return;
    const status = peerClientConnectionStatus({
      ...environment.connection,
      enabled: environment.entry.enabled,
    });
    if (!status.canRetry) return;
    setChecking(environmentId);
    setError(null);
    const result = await retry(environmentId);
    if (!AsyncResult.isSuccess(result)) setError(String(squashAtomCommandFailure(result)));
    setChecking(null);
  };
  return (
    <SettingsSection
      id="connect-peer-computer"
      title="Connect another computer"
      headerAction={
        isSignedIn ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        ) : undefined
      }
    >
      <SettingsRow
        title="Use your other computers here"
        description="Copy this device's approval code to the target computer's device settings. After approving its fingerprint there, copy its pairing link back here. Both devices use the same mines account."
      />
      {!isSignedIn ? <Button onClick={() => openAuthPrompt()}>Sign in to mines</Button> : null}
      {code ? (
        <div className="space-y-2">
          <Button variant="outline" onClick={() => void copyToClipboard(code.code)}>
            {isCopied ? "Copied" : "Copy this device's approval code"}
          </Button>
          <p className="break-all text-xs text-muted-foreground">Fingerprint: {code.fingerprint}</p>
        </div>
      ) : null}
      {isSignedIn ? (
        <>
          <Textarea
            aria-label="Computer pairing link"
            placeholder="Paste mines://peer… from the other computer"
            value={pairing}
            onChange={(event) => setPairing(event.target.value)}
          />
          {target ? (
            <div className="space-y-1 text-sm">
              <p>Connect to {target.host.label}</p>
              <p className="break-all text-xs text-muted-foreground">
                Fingerprint: {target.host.deviceId}
              </p>
              <p className="text-xs text-muted-foreground">
                Account service: {new URL(target.controlUrl).host}
              </p>
              <p className="text-xs text-muted-foreground">
                Continue only with your configured account service. It receives a sign-in token to
                register this device; conversation content travels directly between devices.
              </p>
            </div>
          ) : null}
          {invalid ? (
            <p role="alert" className="text-sm text-destructive">
              {invalid}
            </p>
          ) : null}
          <Button disabled={!target || busy} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Trust computer and connect"}
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {routes.map((route) => {
        const environment = environmentById.get(route.environmentId);
        const status = peerClientConnectionStatus(
          environment ? { ...environment.connection, enabled: environment.entry.enabled } : null,
        );
        return (
          <SettingsRow
            key={route.environmentId}
            title={route.host.label}
            description={
              <span className="space-y-1">
                <span className="block font-medium" role="status">
                  {status.label}
                </span>
                <span className="block">{status.description}</span>
                <span className="block text-xs">
                  Saved history stays available when the computer cannot be reached.
                </span>
              </span>
            }
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || checking !== null || !status.canRetry}
                  onClick={() => void check(route.environmentId)}
                >
                  {checking === route.environmentId ? "Checking…" : status.retryLabel}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || checking !== null}
                  onClick={() => void disconnect(route.environmentId)}
                >
                  Forget
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
