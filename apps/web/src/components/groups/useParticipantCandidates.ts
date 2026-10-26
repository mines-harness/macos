import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { groupHostRoutes } from "../../state/groupHostRoutes";
import { groupMembershipsAtom } from "../../state/groupMemberships";
import { useEnvironmentQuery } from "../../state/query";
import { participantKey, type ParticipantCandidate } from "../chat/draftParticipants";

export function useParticipantCandidates({
  environmentId,
  enabled = true,
}: {
  environmentId: EnvironmentId;
  enabled?: boolean;
}): ReadonlyArray<ParticipantCandidate> {
  const threads = useQuietThreadShells();
  const { environments } = useEnvironments();
  const memberships = useAtomValue(groupMembershipsAtom);
  const hostRoutes = useEnvironmentQuery(
    enabled ? groupHostRoutes({ environmentId, input: {} }) : null,
  );
  const routedHosts = new Set(hostRoutes.data?.routes.map((route) => route.environmentId) ?? []);
  const connectedHosts = new Set(
    environments
      .filter((host) => host.connection.phase === "connected")
      .map((host) => host.environmentId),
  );
  return enabled
    ? threads.flatMap((thread) => {
        if (thread.lineage.relationshipToParent === "subagent") return [];
        const candidate = {
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title,
        };
        const host = environments.find((host) => host.environmentId === thread.environmentId);
        const disabledReason =
          thread.archivedAt !== null
            ? "Reopen this mine before adding it"
            : memberships.has(participantKey(candidate))
              ? "Already in a group"
              : !connectedHosts.has(thread.environmentId)
                ? "Connect this device to add this mine"
                : thread.environmentId !== environmentId && !routedHosts.has(thread.environmentId)
                  ? hostRoutes.isPending
                    ? "Checking group access…"
                    : "Enable groups across computers in Connections"
                  : null;
        return [
          {
            ...candidate,
            ...(host ? { detail: host.label } : {}),
            ...(disabledReason ? { disabledReason } : {}),
          },
        ];
      })
    : [];
}
