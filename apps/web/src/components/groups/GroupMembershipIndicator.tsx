import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { UsersIcon } from "lucide-react";
import { groupMembershipsAtom } from "../../state/groupMemberships";
import { participantKey } from "../chat/draftParticipants";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const groupNamesAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    get(groupMembershipsAtom)
      .get(key)
      ?.map((group) => group.name)
      .join(", "),
  ),
);

export function GroupMembershipIndicator({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const groups = useAtomValue(groupNamesAtom(participantKey({ environmentId, threadId })));
  return groups ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Group chat: ${groups}`}
            className="ml-1 inline-flex shrink-0 text-info-foreground"
          />
        }
      >
        <UsersIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Group chat: {groups}</TooltipPopup>
    </Tooltip>
  ) : null;
}
