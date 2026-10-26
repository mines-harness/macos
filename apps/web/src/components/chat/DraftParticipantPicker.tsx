import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { composerTargetKey, type DraftId } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { groupCreate, groupSend } from "../../state/groups";
import { useParticipantCandidates } from "../groups/useParticipantCandidates";
import { ParticipantPicker } from "./ParticipantPicker";
import { participantSendBusyAtom, useDraftParticipants } from "./draftParticipantState";

export function DraftParticipantPicker({
  draftId,
  environmentId,
}: {
  draftId: DraftId;
  environmentId: EnvironmentId;
}) {
  const [draft, setDraft] = useDraftParticipants(draftId);
  const threads = useParticipantCandidates({ environmentId });
  const busy = useAtomValue(participantSendBusyAtom(composerTargetKey(draftId)));
  const createAllowed = useAtomValue(groupCreate.permissionAtom(environmentId));
  const sendAllowed = useAtomValue(groupSend.permissionAtom(environmentId));
  return (
    <ParticipantPicker
      threads={threads}
      value={draft.members}
      disabled={busy || !createAllowed || !sendAllowed}
      onChange={(members) => setDraft({ revision: randomUUID(), members })}
    />
  );
}
