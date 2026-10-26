import {
  sharedGroupScopeId,
  sharedGroupContentRevision,
} from "@t3tools/shared/minesSharedGroupAccess";
import {
  EnvironmentId,
  GroupChatError,
  GroupMemberInput,
  type GroupSnapshot,
} from "@t3tools/contracts";

export function sharedGroupEnvironmentId(groupKey: string, deviceId: string): EnvironmentId {
  return EnvironmentId.make(sharedGroupScopeId(groupKey, deviceId));
}

export function sharedGroupMemberInputs(
  members: ReadonlyArray<typeof GroupMemberInput.Type>,
  route: EnvironmentId,
): ReadonlyArray<typeof GroupMemberInput.Type> {
  if (members.some((member) => member.environmentId !== undefined))
    throw new GroupChatError({
      code: "invalid-members",
      message: "A shared chat must belong to the device contributing it.",
    });
  return members.map((member) => ({ ...member, environmentId: route }));
}

export function sharedGroupSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
  return {
    ...snapshot,
    rounds: snapshot.rounds.map(({ catalogContextRevision: _revision, ...round }) => round),
  };
}

export function sharedGroupRevision(snapshot: GroupSnapshot): string {
  return sharedGroupContentRevision(sharedGroupSnapshot(snapshot));
}
