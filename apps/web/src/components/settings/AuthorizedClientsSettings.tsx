import { useState } from "react";
import { AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";
import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
} from "../../environments/primary";
import { authEnvironment } from "../../state/auth";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  canRevokeOtherClients,
  formatAccessTimestamp,
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  summarizeAuthorizedClients,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from "./ConnectionsSettings.logic";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

/** Session grants are separate from trusted peer keys; both can be revoked. */
export function AuthorizedClientsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const access = useEnvironmentQuery(
    environmentId !== null && canRead
      ? authEnvironment.accessChanges({ environmentId, input: null })
      : null,
  );
  const snapshot = access.data?.type === "snapshot" ? access.data.payload : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useRelativeTimeTick(10_000);
  if (environmentId === null || !canRead) return null;
  const sessions = sortDesktopClientSessions(
    (snapshot?.clientSessions ?? []).map(toDesktopClientSessionRecord),
  );
  const links = sortDesktopPairingLinks(
    (snapshot?.pairingLinks ?? []).map(toDesktopPairingLinkRecord),
  );
  const revoke = async (action: () => Promise<unknown>) => {
    if (!readEnvironmentScope(environmentId, AuthAccessWriteScope) || pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
      access.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsSection
      id="authorized-clients"
      title="Authorized clients"
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || pending || snapshot === null || !canRevokeOtherClients(sessions)}
          onClick={() => void revoke(revokeOtherServerClientSessions)}
        >
          Revoke other clients
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        {snapshot === null
          ? "Loading authorized clients…"
          : summarizeAuthorizedClients(sessions, links)}
        . Revoke a session here, or revoke a device key under Direct device access to prevent new
        connections.
      </p>
      {(error ?? access.error) ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? access.error}
        </p>
      ) : null}
      {sessions.map((session) => (
        <SettingsRow
          key={session.sessionId}
          title={`${session.client.label ?? session.client.deviceType}${session.current ? " · this client" : ""}`}
          description={
            <span>
              {session.connected ? "Connected" : "Disconnected"}
              {session.lastConnectedAt
                ? ` · last connected ${formatElapsedDurationLabel(session.lastConnectedAt, now)} ago`
                : ""}
              . {formatExpiresInLabel(session.expiresAt, now)}.{" "}
              <span className="block text-xs">Granted: {session.scopes.join(", ")}</span>
            </span>
          }
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWrite || pending || session.current}
              onClick={() => void revoke(() => revokeServerClientSession(session.sessionId))}
            >
              Revoke
            </Button>
          }
        />
      ))}
      {links.map((link) => (
        <SettingsRow
          key={link.id}
          title={link.label ?? "Unused pairing grant"}
          description={`Created ${formatAccessTimestamp(link.createdAt)} · ${formatExpiresInLabel(link.expiresAt, now)}`}
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWrite || pending}
              onClick={() => void revoke(() => revokeServerPairingLink(link.id))}
            >
              Revoke grant
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
