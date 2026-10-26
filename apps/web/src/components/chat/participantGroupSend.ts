import type {
  EnvironmentId,
  GroupCreateInput,
  GroupSendInput,
  GroupSnapshot,
} from "@t3tools/contracts";
import { participantGroupMembers, type ParticipantCandidate } from "./draftParticipants";

export async function submitParticipantGroup(
  input: {
    readonly environmentId: EnvironmentId;
    readonly members: ReadonlyArray<ParticipantCandidate>;
    readonly title: string;
    readonly message: string;
    readonly requestId: string;
    readonly sendRequestId?: string;
  },
  commands: {
    readonly create: (input: GroupCreateInput) => Promise<GroupSnapshot>;
    readonly send: (input: GroupSendInput) => Promise<unknown>;
  },
) {
  const members = participantGroupMembers(input.members);
  const lead = members[0];
  const snapshot = await commands.create({
    name: input.title.slice(0, 120),
    workflow: "team",
    members,
    ...(lead ? { leadThreadId: lead.threadId, leadEnvironmentId: lead.environmentId } : {}),
    clientRequestId: input.requestId,
  });
  await commands.send({
    groupId: snapshot.group.id,
    message: input.message,
    mentionEveryone: true,
    clientRequestId: input.sendRequestId ?? input.requestId,
  });
  return snapshot;
}
