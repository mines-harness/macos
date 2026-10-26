import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { decodePeerApproval, encodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { hasMinesIdentityConfig, minesControlUrl } from "../../cloud/publicConfig";
import { minesDeviceSyncPreferences } from "../../cloud/minesDeviceSyncPreference";
import { createServerPairingCredential, revokeServerPairingLink } from "../../environments/primary";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  peerApprove,
  peerConfigure,
  peerConnectionState,
  peerCheckDevice,
  peerDisable,
  peerRevoke,
  peerState,
  peerStatus,
} from "../../state/peers";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useMinesAuthPrompt } from "../clerk/useMinesAuthPrompt";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { PeerDeviceStatusText } from "./PeerDeviceStatusText";
import { useAccountPeerDirectory } from "./useAccountPeerDirectory";
import { describePeerDevice } from "./peerDeviceStatus.logic";

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The device request could not be completed.";
}

const noAccountDirectory = {
  data: null,
  isPending: false,
  error: null,
  refresh: () => {},
};

export function MinesPeerSettings() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const allowed = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  if (!environmentId || !allowed) {
    return (
      <SettingsSection id="direct-device-access" title="Direct device access">
        <SettingsRow
          title="Open this computer's workspace"
          description="Device approval requires access-management permission on the computer you want to control."
        />
      </SettingsSection>
    );
  }
  return hasMinesIdentityConfig() ? (
    <PeerSettingsWithAccountDirectory key={environmentId} environmentId={environmentId} />
  ) : (
    <PeerSettingsContent
      key={environmentId}
      environmentId={environmentId}
      directory={noAccountDirectory}
    />
  );
}

function PeerSettingsWithAccountDirectory({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const directory = useAccountPeerDirectory();
  return <PeerSettingsContent environmentId={environmentId} directory={directory} />;
}

function PeerSettingsContent({
  environmentId,
  directory,
}: {
  readonly environmentId: EnvironmentId;
  readonly directory: ReturnType<typeof useAccountPeerDirectory>;
}) {
  const trust = useEnvironmentQuery(peerState({ environmentId, input: {} }));
  const connection = useEnvironmentQuery(peerConnectionState({ environmentId, input: {} }));
  const deviceStatus = useEnvironmentQuery(peerStatus({ environmentId, input: {} }));
  const canCheck = useAtomValue(peerCheckDevice.permissionAtom(environmentId));
  const check = useAtomCommand(peerCheckDevice, { reportFailure: false });
  const approve = useAtomCommand(peerApprove, { reportFailure: false });
  const revoke = useAtomCommand(peerRevoke, { reportFailure: false });
  const disable = useAtomCommand(peerDisable, { reportFailure: false });
  const [approvalCode, setApprovalCode] = useState("");
  const [candidate, setCandidate] = useState<PeerDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingDevice, setCheckingDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    readonly value: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly deviceId: string;
    readonly label: string;
  } | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const nowMs = useRelativeTimeTick(15_000);
  const pairingExpired = pairing !== null && Date.parse(pairing.expiresAt) <= nowMs;
  const refresh = () => {
    trust.refresh();
    connection.refresh();
    deviceStatus.refresh();
    directory.refresh();
  };
  const checkConnection = async (deviceId: string) => {
    if (checkingDevice || busy || !canCheck) return;
    setCheckingDevice(deviceId);
    setError(null);
    try {
      const result = await check({ environmentId, input: { deviceId } });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      deviceStatus.refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setCheckingDevice(null);
    }
  };
  const statusById = new Map(
    deviceStatus.data?.devices.map((status) => [status.device.deviceId, status]),
  );
  const presenceById = new Map(
    directory.data?.presence.map((presence) => [presence.deviceId, presence.online]),
  );
  const approvedIds = new Set(trust.data?.approvedDevices.map((device) => device.deviceId));
  const otherAccountDevices =
    directory.data?.devices.filter(
      (device) =>
        device.deviceId !== trust.data?.device.deviceId && !approvedIds.has(device.deviceId),
    ) ?? [];
  const prepareApproval = () => {
    try {
      const device = decodePeerApproval(approvalCode);
      if (device.deviceId === trust.data?.device.deviceId) {
        throw new Error(
          "This is the current computer's code. Paste the code shown on the other device.",
        );
      }
      setCandidate(device);
      setError(null);
    } catch (cause) {
      setCandidate(null);
      setError(failureMessage(cause));
    }
  };
  const createPairing = async (device: PeerDevice, approveFirst: boolean) => {
    if (!trust.data || !connection.data?.online || !connection.data.controlUrl) return;
    setBusy(true);
    setError(null);
    try {
      if (approveFirst) {
        const result = await approve({ environmentId, input: { device } });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        trust.refresh();
      }
      // Replace outstanding grants instead of leaving multiple usable device setup codes.
      if (pairing) await revokeServerPairingLink(pairing.credentialId);
      const scopes = AuthStandardClientScopes.filter((scope) =>
        readEnvironmentScope(environmentId, scope),
      );
      if (!scopes.length) throw new Error("Your session cannot grant device access.");
      const grant = await createServerPairingCredential({ label: device.label, scopes });
      const expiresAt = DateTime.formatIso(grant.expiresAt);
      const value = encodePeerPairing({
        version: 1,
        host: trust.data.device,
        controlUrl: connection.data.controlUrl,
        stunServers: connection.data.stunServers,
        environmentId,
        pairingToken: grant.credential,
        expiresAt,
      });
      setPairing({
        value,
        credentialId: grant.id,
        expiresAt,
        deviceId: device.deviceId,
        label: device.label,
      });
      setCandidate(null);
      setApprovalCode("");
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const revokeDevice = async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await revoke({ environmentId, input: { deviceId } });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      if (pairing?.deviceId === deviceId) {
        await revokeServerPairingLink(pairing.credentialId);
        setPairing(null);
      }
      trust.refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const disableAccess = async () => {
    setBusy(true);
    setError(null);
    try {
      let preferenceSaved = true;
      const { accountId, controlUrl } = connection.data ?? {};
      if (accountId && controlUrl) {
        try {
          minesDeviceSyncPreferences.setEnabled({ accountId, environmentId, controlUrl }, false);
        } catch {
          preferenceSaved = false;
        }
      }
      const result = await disable({ environmentId, input: {} });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      if (pairing) await revokeServerPairingLink(pairing.credentialId);
      setPairing(null);
      refresh();
      if (!preferenceSaved)
        throw new Error(
          "Device access is disabled, but this preference could not be saved. Allow local storage before restarting Mines.",
        );
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="direct-device-access"
      title="Direct device access"
      headerAction={
        <Button size="sm" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title={
          connection.data?.online
            ? "Device discovery is connected"
            : connection.data?.configured
              ? "Device discovery is unavailable"
              : "Connect your devices"
        }
        description="Other devices can discover this computer when discovery is connected. Check an approved device below to confirm a direct connection. Keep this computer awake for remote access."
        control={
          connection.data?.configured ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void disableAccess()}
            >
              Disable access
            </Button>
          ) : undefined
        }
      />
      {connection.data?.failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connection status: {connection.data.failure}. Retry or verify the configured signaling
          service.
        </p>
      ) : null}
      {hasMinesIdentityConfig() ? (
        <PeerConfigureControls
          environmentId={environmentId}
          configuredUrl={connection.data?.controlUrl ?? ""}
          configuredStunServers={connection.data?.stunServers ?? []}
          onConfigured={refresh}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          This build needs a mines sign-in configuration before it can register devices. You can
          continue using the local workspace.
        </p>
      )}
      {trust.data ? (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Approve a device</p>
          <p className="text-sm text-muted-foreground">
            On a phone, open Devices → Add computer. On another computer, open Connections → Connect
            a computer. Copy its device approval code here, then compare the key on both devices.
          </p>
          <Textarea
            aria-label="Device approval code"
            placeholder="Paste the other device's approval code"
            value={approvalCode}
            onChange={(event) => {
              setApprovalCode(event.target.value);
              setCandidate(null);
            }}
            disabled={busy}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!approvalCode.trim() || busy}
            onClick={prepareApproval}
          >
            Review device
          </Button>
          {candidate ? (
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-medium">{candidate.label}</p>
              <p className="text-xs break-all font-mono text-muted-foreground">
                {candidate.publicKey}
              </p>
              <p className="text-sm text-muted-foreground">
                Approve only when this key matches the other device. This grants prompting,
                approvals and workspace controls using your session's permitted scopes.
              </p>
              <Button
                disabled={busy || !connection.data?.online}
                onClick={() => void createPairing(candidate, true)}
              >
                {busy ? "Preparing…" : "Approve & create pairing code"}
              </Button>
              {!connection.data?.online ? (
                <p className="text-xs text-muted-foreground">
                  Enable device signaling before creating a pairing code.
                </p>
              ) : null}
            </div>
          ) : null}
          {pairing ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">Scan with {pairing.label}</p>
              {pairingExpired ? (
                <p role="status" className="text-sm text-muted-foreground">
                  This pairing code expired. Create a new code from the device row below.
                </p>
              ) : (
                <QRCodeSvg
                  value={pairing.value}
                  size={240}
                  marginSize={4}
                  title="Scan or copy this one-time mines pairing code on the other device"
                />
              )}
              <p className="text-sm text-muted-foreground">
                The other device will test the direct connection before confirming setup. Expires{" "}
                {new Date(pairing.expiresAt).toLocaleTimeString()}.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={pairingExpired}
                onClick={() => copyToClipboard(pairing.value, undefined)}
              >
                {isCopied ? "Copied" : "Copy pairing code"}
              </Button>
            </div>
          ) : null}
          {trust.data.approvedDevices.map((device) => {
            const status = statusById.get(device.deviceId);
            const online = presenceById.get(device.deviceId);
            return (
              <SettingsRow
                key={device.deviceId}
                title={device.label}
                description={
                  <span className="block space-y-2">
                    <PeerDeviceStatusText
                      {...(deviceStatus.error
                        ? { status: "unknown" as const }
                        : status
                          ? { status: status.status }
                          : {})}
                      {...(online === undefined ? {} : { online })}
                      checkedAt={status?.checkedAt}
                    />
                    <span className="block break-all font-mono text-xs">{device.publicKey}</span>
                  </span>
                }
                control={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || checkingDevice !== null || !canCheck || !connection.data?.configured
                      }
                      onClick={() => void checkConnection(device.deviceId)}
                    >
                      {checkingDevice === device.deviceId
                        ? "Checking…"
                        : status?.status === "unavailable"
                          ? "Retry connection"
                          : "Check connection"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !connection.data?.online}
                      onClick={() => void createPairing(device, false)}
                    >
                      New code
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revokeDevice(device.deviceId)}
                    >
                      Revoke
                    </Button>
                  </div>
                }
              />
            );
          })}
        </div>
      ) : null}
      {directory.data || directory.error || directory.isPending ? (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Other devices on your account</p>
          <p className="text-xs text-muted-foreground">
            Online means the device is available for discovery. Direct access still requires
            approval and a successful connection.
          </p>
          {directory.isPending ? (
            <p role="status" className="text-xs text-muted-foreground">
              Updating device presence…
            </p>
          ) : null}
          {directory.error ? (
            <p role="status" className="text-xs text-muted-foreground">
              {directory.error}
            </p>
          ) : null}
          {!directory.error && otherAccountDevices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other unapproved devices are registered.
            </p>
          ) : null}
          {otherAccountDevices.map((device) => (
            <SettingsRow
              key={device.deviceId}
              title={device.label}
              description={
                <span className="block space-y-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {
                        describePeerDevice(
                          presenceById.has(device.deviceId)
                            ? { online: presenceById.get(device.deviceId)! }
                            : {},
                        ).presenceLabel
                      }
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Approval required on this computer
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Use this device’s approval code above before checking its direct connection.
                  </span>
                </span>
              }
            />
          ))}
        </div>
      ) : null}
      {deviceStatus.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connection status could not be loaded. Update or reconnect this computer, then refresh.
        </p>
      ) : null}
      {error || trust.error || connection.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? trust.error ?? connection.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

function PeerConfigureControls({
  environmentId,
  configuredUrl,
  configuredStunServers,
  onConfigured,
}: {
  readonly environmentId: EnvironmentId;
  readonly configuredUrl: string;
  readonly configuredStunServers: readonly string[];
  readonly onConfigured: () => void;
}) {
  const { isLoaded, isSignedIn, userId, getToken } = useMinesAuth();
  const { openAuthPrompt } = useMinesAuthPrompt();
  const configure = useAtomCommand(peerConfigure, { reportFailure: false });
  const [controlUrl, setControlUrl] = useState<string | null>(null);
  const [stunUrl, setStunUrl] = useState<string | null>(null);
  const effectiveControlUrl = controlUrl ?? (configuredUrl || minesControlUrl() || "");
  const effectiveStunUrl =
    stunUrl ?? (configuredStunServers[0] || import.meta.env.VITE_MINES_STUN_URL || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!userId)
        throw new Error("Sign in to your mines account before registering this computer.");
      const token = await getToken();
      if (!token)
        throw new Error("Sign in to your mines account before registering this computer.");
      const result = await configure({
        environmentId,
        input: {
          controlUrl: effectiveControlUrl.trim(),
          bearerToken: token,
          stunServers: effectiveStunUrl.trim() ? [effectiveStunUrl.trim()] : [],
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      minesDeviceSyncPreferences.setEnabled(
        { accountId: userId, environmentId, controlUrl: effectiveControlUrl.trim() },
        true,
      );
      onConfigured();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {!isSignedIn ? (
        <Button size="sm" disabled={!isLoaded} onClick={openAuthPrompt}>
          Sign in to mines
        </Button>
      ) : (
        <>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Control server URL</span>
            <Input
              aria-label="Control server URL"
              placeholder="https://your-control-server"
              value={effectiveControlUrl}
              onChange={(event) => setControlUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">STUN server</span>
            <Input
              aria-label="STUN server"
              placeholder="stun:your-control-server:3478"
              value={effectiveStunUrl}
              onChange={(event) => setStunUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Without STUN, only directly reachable local networks can connect. No relay fallback is
            used.
          </p>
          <Button
            size="sm"
            disabled={busy || !effectiveControlUrl.trim()}
            onClick={() => void enable()}
          >
            {busy
              ? "Registering…"
              : configuredUrl
                ? "Reconnect signaling"
                : "Enable device signaling"}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
