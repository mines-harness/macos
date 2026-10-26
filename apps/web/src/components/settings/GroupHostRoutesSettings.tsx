import { useState } from "react";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  decodePeerPairing,
  encodePeerApproval,
  type PeerPairingPayload,
} from "@t3tools/shared/minesPeerPairing";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  connectGroupHost,
  disconnectGroupHost,
  groupHostRoutes,
} from "../../state/groupHostRoutes";
import { peerApprove, peerConnectionState, peerState } from "../../state/peers";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GroupHostRoutesSettings() {
  const primary = usePrimaryEnvironment();
  const id = primary?.environmentId ?? null;
  const allowed = useEnvironmentScope(id, AuthAccessWriteScope);
  return id && allowed ? <GroupHostRoutesContent key={id} environmentId={id} /> : null;
}

function GroupHostRoutesContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const routes = useEnvironmentQuery(groupHostRoutes({ environmentId, input: {} }));
  const trust = useEnvironmentQuery(peerState({ environmentId, input: {} }));
  const signaling = useEnvironmentQuery(peerConnectionState({ environmentId, input: {} }));
  const connect = useAtomCommand(connectGroupHost, { reportFailure: false });
  const disconnect = useAtomCommand(disconnectGroupHost, { reportFailure: false });
  const approve = useAtomCommand(peerApprove, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [code, setCode] = useState("");
  const [candidate, setCandidate] = useState<PeerPairingPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const report = (failure: unknown) =>
    setError(
      failure instanceof Error
        ? failure.message
        : "The host could not be connected. Create a fresh pairing code and try again.",
    );
  const review = () => {
    try {
      const decoded = decodePeerPairing(code, Math.floor(Date.now() / 1000));
      if (decoded.environmentId === environmentId)
        throw new Error("Use a pairing code from another computer.");
      if (
        new URL(decoded.controlUrl).origin !==
        (signaling.data?.controlUrl ? new URL(signaling.data.controlUrl).origin : null)
      )
        throw new Error(
          "Both computers must use the same account server. Configure direct access above first.",
        );
      setCandidate(decoded);
      setError(null);
      setConnected(null);
    } catch (cause) {
      setCandidate(null);
      report(cause);
    }
  };
  const submit = async () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const approval = await approve({ environmentId, input: { device: candidate.host } });
      if (approval._tag !== "Success") throw squashAtomCommandFailure(approval);
      const result = await connect({
        environmentId,
        input: {
          environmentId: candidate.environmentId,
          deviceId: candidate.host.deviceId,
          pairingCode: candidate.pairingToken,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      setConnected(candidate.host.label);
      setCandidate(null);
      setCode("");
      routes.refresh();
      trust.refresh();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (remoteEnvironmentId: EnvironmentId) => {
    setBusy(true);
    setError(null);
    try {
      const result = await disconnect({
        environmentId,
        input: { environmentId: remoteEnvironmentId },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      routes.refresh();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="group-host-routes" title="Groups across computers">
      <SettingsRow
        title="Connect this coordinator to another device"
        description="Group messages travel directly between awake computers. Each computer must approve the other and connect in both directions so members can report updates and request one another. Enable direct access above first."
      />
      {trust.data ? (
        <SettingsRow
          title="This computer's approval code"
          description="Copy this to the other computer's device approval field. There, approve it and create a fresh pairing code for this coordinator."
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyToClipboard(encodePeerApproval(trust.data!.device))}
            >
              {isCopied ? "Copied" : "Copy device code"}
            </Button>
          }
        />
      ) : null}
      {(routes.data?.routes ?? []).map((route) => (
        <SettingsRow
          key={route.environmentId}
          title={route.label}
          description={<span className="break-all">Approved host · {route.deviceId}</span>}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void remove(route.environmentId)}
            >
              Disconnect
            </Button>
          }
        />
      ))}
      <div className="space-y-3 px-4 py-3">
        <label className="block text-sm font-medium" htmlFor="group-host-pairing">
          Pairing code from the other computer
        </label>
        <Textarea
          id="group-host-pairing"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setCandidate(null);
          }}
          placeholder="mines://peer…"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        {candidate ? (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>
              Connect to <strong>{candidate.host.label}</strong>
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Device fingerprint: {candidate.host.deviceId}
            </p>
            <p className="text-muted-foreground">
              This grants this computer access to read and operate agent mines on that device. Check
              the fingerprint on the other computer before approving.
            </p>
            <Button disabled={busy || !signaling.data?.online} onClick={() => void submit()}>
              {busy ? "Connecting…" : "Approve and connect"}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            disabled={busy || !code.trim() || !signaling.data?.online}
            onClick={review}
          >
            Review connection
          </Button>
        )}
        {!signaling.data?.online ? (
          <p className="text-sm text-muted-foreground">
            Direct access must be online before connecting a group host.
          </p>
        ) : null}
        {connected ? (
          <p role="status" className="text-sm">
            Connected to {connected}. Complete the reverse connection on that computer to enable
            group replies.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
