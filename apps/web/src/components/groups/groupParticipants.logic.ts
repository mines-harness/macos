import type { EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { participantKey } from "../chat/draftParticipants";

export interface ParticipantGroup {
  readonly environmentId: EnvironmentId;
  readonly groupId: GroupId;
  readonly name: string;
}

export function indexGroupMemberships(
  lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly groups: ReadonlyArray<{
      readonly id: GroupId;
      readonly name: string;
      readonly archivedAt: string | null;
      readonly visibility?: "private" | "shared";
    }>;
    readonly memberships: ReadonlyArray<{
      readonly groupId: GroupId;
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId | null;
    }>;
  }>,
): ReadonlyMap<string, ReadonlyArray<ParticipantGroup>> {
  const result = new Map<string, ParticipantGroup[]>();
  for (const list of lists) {
    const activeGroups = new Map(
      list.groups
        .filter((group) => group.archivedAt === null && group.visibility !== "shared")
        .map((group) => [group.id, group]),
    );
    for (const membership of list.memberships) {
      const group = activeGroups.get(membership.groupId);
      if (!group) continue;
      const key = participantKey({
        environmentId: membership.environmentId ?? list.environmentId,
        threadId: membership.threadId,
      });
      const memberships = result.get(key) ?? [];
      if (
        !memberships.some(
          (existing) =>
            existing.environmentId === list.environmentId && existing.groupId === group.id,
        )
      )
        memberships.push({
          environmentId: list.environmentId,
          groupId: group.id,
          name: group.name,
        });
      result.set(key, memberships);
    }
  }
  return result;
}
