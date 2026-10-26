import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, GroupSnapshot, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { groupAddMembers, groupCreate, groupSubscription } from "../../state/groups";
import { groupMembershipsAtom, refreshGroupMemberships } from "../../state/groupMemberships";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ParticipantPicker, type ParticipantCandidate } from "../chat/ParticipantPicker";
import { participantGroupMembers, participantKey } from "../chat/draftParticipants";
import { Button } from "../ui/button";
import { useParticipantCandidates } from "./useParticipantCandidates";

export function MineParticipantsControl({
  environmentId,
  threadId,
  title,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
}) {
  const mine = { environmentId, threadId, title };
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const memberships = useAtomValue(groupMembershipsAtom).get(participantKey(mine)) ?? [];
  const membership = memberships.length === 1 ? memberships[0] : undefined;
  const group = useEnvironmentQuery(
    membership
      ? groupSubscription({
          environmentId: membership.environmentId,
          input: { groupId: membership.groupId },
        })
      : null,
  );
  if (!thread || thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
    return null;
  if (memberships.length > 1)
    return <span className="text-xs text-muted-foreground">Open a group to add participants.</span>;
  if (membership)
    return group.data ? (
      <GroupParticipantsControl
        key={`${membership.environmentId}:${membership.groupId}`}
        environmentId={membership.environmentId}
        snapshot={group.data}
      />
    ) : (
      <span className="text-xs text-muted-foreground">
        {group.error ?? "Loading participants…"}
      </span>
    );
  return (
    <GroupParticipantsControl
      key={participantKey(mine)}
      environmentId={environmentId}
      mine={mine}
    />
  );
}

export function GroupParticipantsControl({
  environmentId,
  ...context
}: {
  environmentId: EnvironmentId;
} & (
  | { readonly snapshot: GroupSnapshot; readonly mine?: never }
  | { readonly mine: ParticipantCandidate; readonly snapshot?: never }
)) {
  const snapshot = context.snapshot;
  const mine = context.mine;
  const create = useOrchestrationCommand(groupCreate, { reportFailure: false });
  const add = useOrchestrationCommand(groupAddMembers, { reportFailure: false });
  const createAllowed = useAtomValue(groupCreate.permissionAtom(environmentId));
  const addAllowed = useAtomValue(groupAddMembers.permissionAtom(environmentId));
  const allowed = snapshot ? addAllowed && snapshot.group.archivedAt === null : createAllowed;
  const candidates = useParticipantCandidates({ environmentId, enabled: allowed });
  const currentKeys = new Set(
    snapshot
      ? snapshot.members.map((member) =>
          participantKey({
            environmentId: member.environmentId ?? environmentId,
            threadId: member.threadId,
          }),
        )
      : mine
        ? [participantKey(mine)]
        : [],
  );
  const threads = candidates.map((candidate) =>
    currentKeys.has(participantKey(candidate))
      ? {
          ...candidate,
          disabledReason: snapshot ? "Already a participant" : "This mine is the group lead",
        }
      : candidate,
  );
  const availableKeys = new Set(
    threads.filter((candidate) => !candidate.disabledReason).map(participantKey),
  );
  const [selected, setSelected] = useState<ReadonlyArray<ParticipantCandidate>>([]);
  const [requestId, setRequestId] = useState(randomUUID);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const navigate = useNavigate();
  const available = selected.every((candidate) => availableKeys.has(participantKey(candidate)));
  const remaining = Math.max(0, 12 - (snapshot?.members.length ?? 1));
  const submit = async () => {
    if (busy || !allowed || !selected.length || !available || selected.length > remaining) return;
    setBusy(true);
    setError(null);
    const result = snapshot
      ? await add({
          environmentId,
          input: {
            groupId: snapshot.group.id,
            members: participantGroupMembers(
              selected,
              snapshot.members.map((member) => member.alias),
            ),
            clientRequestId: requestId,
          },
        })
      : mine
        ? await create({
            environmentId,
            input: {
              name: `${mine.title} group`.slice(0, 120),
              workflow: "team",
              members: participantGroupMembers([mine, ...selected]),
              leadThreadId: mine.threadId,
              leadEnvironmentId: mine.environmentId,
              clientRequestId: requestId,
            },
          })
        : null;
    if (result?._tag === "Success") {
      refreshGroupMemberships(environmentId);
      if (!mounted.current) return;
      setSelected([]);
      setRequestId(randomUUID());
      if (!snapshot)
        void navigate({
          to: "/$environmentId/groups/$groupId",
          params: { environmentId, groupId: result.value.group.id },
        });
    } else if (mounted.current) {
      const failure = result ? squashAtomCommandFailure(result) : null;
      setError(
        failure instanceof Error ? failure.message : "Could not add these participants. Try again.",
      );
    }
    if (mounted.current) setBusy(false);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <ParticipantPicker
        threads={threads}
        value={selected}
        disabled={busy || !allowed || remaining === 0}
        label="Add participant"
        maxParticipants={remaining}
        onChange={(next) => {
          setSelected(next);
          setRequestId(randomUUID());
          setError(null);
        }}
      />
      {selected.length ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy || !allowed || !available || selected.length > remaining}
          onClick={() => void submit()}
        >
          {busy ? "Adding…" : snapshot ? "Add selected" : "Create group"}
        </Button>
      ) : null}
      {selected.length && !available ? (
        <span className="text-muted-foreground">A selected mine is no longer available.</span>
      ) : null}
      {error ? (
        <span role="alert" className="w-full text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
