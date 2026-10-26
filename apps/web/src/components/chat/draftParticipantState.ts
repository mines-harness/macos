import { Atom } from "effect/reactivity";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import { composerTargetKey } from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { EMPTY_PARTICIPANT_DRAFT, ParticipantDraft } from "./draftParticipants";

const participantDraftKey = (target: ComposerThreadTarget) =>
  `mines:composer-participants:${composerTargetKey(target)}`;

export function useDraftParticipants(target: ComposerThreadTarget) {
  return useLocalStorage(participantDraftKey(target), EMPTY_PARTICIPANT_DRAFT, ParticipantDraft);
}

export const participantSendBusyAtom = Atom.family((_key: string) =>
  Atom.make(false).pipe(Atom.keepAlive),
);
