import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { composerTargetKey, type DraftId } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { groupCreate, groupSend } from "../../state/groups";
import { useParticipantCandidates } from "../groups/useParticipantCandidates";
import { ParticipantPicker } from "./ParticipantPicker";
import { participantSendBusyAtom, useDraftParticipants } from "./draftParticipantState";
import { participantKey } from "./draftParticipants";

export function DraftParticipantPicker({
  draftId,
  environmentId,
  contextEntityId = null,
}: {
  draftId: DraftId;
  environmentId: EnvironmentId;
  contextEntityId?: string | null;
}) {
  const [draft, setDraft] = useDraftParticipants(draftId);
  const { candidates: threads, sectionId } = useParticipantCandidates({
    environmentId,
    contextEntityId,
  });
  const allowed = new Set(threads.map(participantKey));
  const members = sectionId
    ? draft.members.filter((member) => allowed.has(participantKey(member)))
    : draft.members;
  useEffect(() => {
    if (members.length !== draft.members.length) setDraft({ revision: randomUUID(), members });
  }, [members, draft.members.length, setDraft]);
  const busy = useAtomValue(participantSendBusyAtom(composerTargetKey(draftId)));
  const createAllowed = useAtomValue(groupCreate.permissionAtom(environmentId));
  const sendAllowed = useAtomValue(groupSend.permissionAtom(environmentId));
  return (
    <ParticipantPicker
      threads={threads}
      value={members}
      disabled={busy || !createAllowed || !sendAllowed}
      onChange={(members) => setDraft({ revision: randomUUID(), members })}
    />
  );
}
