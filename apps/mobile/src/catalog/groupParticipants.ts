import type { EnvironmentId } from "@t3tools/contracts";

export const groupMemberKey = (environmentId: EnvironmentId, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

export function groupMembershipLabels(
  lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly groups: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly archivedAt: string | null;
      readonly visibility?: "private" | "shared";
    }>;
    readonly memberships: ReadonlyArray<{
      readonly groupId: string;
      readonly threadId: string;
      readonly environmentId: EnvironmentId | null;
    }>;
  }>,
) {
  const result = new Map<string, string[]>();
  for (const list of lists) {
    const names = new Map(
      list.groups
        .filter((group) => group.archivedAt === null && group.visibility !== "shared")
        .map((group) => [group.id, group.name]),
    );
    for (const membership of list.memberships) {
      const name = names.get(membership.groupId);
      if (!name) continue;
      const key = groupMemberKey(
        membership.environmentId ?? list.environmentId,
        membership.threadId,
      );
      result.set(key, [...(result.get(key) ?? []), name]);
    }
  }
  return result;
}

export function nextGroupAlias(title: string, members: ReadonlyArray<{ readonly alias: string }>) {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 24) || "member";
  const stem = base === "everyone" ? "teammate" : base;
  const used = new Set(members.map((member) => member.alias.toLowerCase()));
  let alias = stem;
  let suffix = 2;
  while (used.has(alias)) alias = `${stem}-${suffix++}`;
  return alias;
}

export function availableGroupParticipants<
  T extends {
    readonly id: string;
    readonly environmentId: EnvironmentId;
    readonly archivedAt: string | null;
    readonly lineage: { readonly relationshipToParent: string | null };
  },
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly environmentId: EnvironmentId;
  readonly routedHosts: ReadonlySet<EnvironmentId>;
  readonly connectedHosts: ReadonlySet<EnvironmentId>;
  readonly occupiedKeys: ReadonlySet<string>;
}) {
  return input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !input.occupiedKeys.has(groupMemberKey(thread.environmentId, thread.id)) &&
      (thread.environmentId === input.environmentId ||
        (input.routedHosts.has(thread.environmentId) &&
          input.connectedHosts.has(thread.environmentId))),
  );
}
