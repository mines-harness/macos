import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { catalogHostId } from "@t3tools/client-runtime/catalog";
import type { MinesCatalogEntry, MinesCatalogSnapshot } from "@t3tools/contracts/minesCatalog";

export function sectionParticipantThreads<
  T extends {
    readonly environmentId: string;
    readonly id: string;
    readonly projectId: string | null;
  },
>(snapshot: MinesCatalogSnapshot, contextEntityId: string | null, threads: ReadonlyArray<T>) {
  const sections = new Map<string, string | null>();
  const visit = (entries: readonly MinesCatalogEntry[], sectionId: string | null) => {
    for (const entry of entries) {
      if (sections.has(entry.entity.id)) continue;
      const owner = entry.entity.kind === "section" ? entry.entity.id : sectionId;
      sections.set(entry.entity.id, owner);
      visit(entry.children, owner);
    }
  };
  visit(snapshot.roots, null);
  const sectionId = contextEntityId ? (sections.get(contextEntityId) ?? null) : null;
  return {
    sectionId,
    threads:
      sectionId === null
        ? threads
        : threads.filter((thread) => {
            const mineId = catalogHostId("thread", thread.environmentId, thread.id);
            const projectId =
              thread.projectId === null
                ? null
                : catalogHostId("project", thread.environmentId, thread.projectId);
            return (
              (sections.has(mineId)
                ? sections.get(mineId)
                : projectId
                  ? sections.get(projectId)
                  : null) === sectionId
            );
          }),
  };
}

export const ParticipantCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  disabledReason: Schema.optional(Schema.String),
});
export type ParticipantCandidate = typeof ParticipantCandidate.Type;

export const ParticipantDraft = Schema.Struct({
  revision: Schema.String,
  members: Schema.Array(ParticipantCandidate),
});
export type ParticipantDraft = typeof ParticipantDraft.Type;
export const EMPTY_PARTICIPANT_DRAFT: ParticipantDraft = { revision: "", members: [] };

export const participantKey = (member: Pick<ParticipantCandidate, "environmentId" | "threadId">) =>
  JSON.stringify([member.environmentId, member.threadId]);

export function participantLabel(
  members: ReadonlyArray<ParticipantCandidate>,
  empty = "Add participants",
) {
  const first = members[0];
  if (!first) return empty;
  const others = members.length - 1;
  return others === 0
    ? first.title
    : `${first.title} + ${others} ${others === 1 ? "other" : "others"}`;
}

export function participantOptions(
  threads: ReadonlyArray<ParticipantCandidate>,
  selected: ReadonlyArray<ParticipantCandidate>,
  query: string,
) {
  const available = new Map(threads.map((thread) => [participantKey(thread), thread]));
  const ordered = new Map(
    selected.map((thread) => [
      participantKey(thread),
      available.get(participantKey(thread)) ?? thread,
    ]),
  );
  for (const thread of threads) ordered.set(participantKey(thread), thread);
  const search = query.trim().toLocaleLowerCase();
  return [...ordered.values()].filter(
    (thread) =>
      !search || `${thread.title} ${thread.detail ?? ""}`.toLocaleLowerCase().includes(search),
  );
}

export function participantGroupMembers(
  members: ReadonlyArray<ParticipantCandidate>,
  occupiedAliases: ReadonlyArray<string> = [],
) {
  const aliases = new Set(occupiedAliases.map((alias) => alias.toLowerCase()));
  return members.map((member) => {
    const normalized =
      member.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/^[^a-z]+/, "")
        .slice(0, 24) || "member";
    const base = normalized === "everyone" ? "teammate" : normalized;
    let alias = base;
    let suffix = 2;
    while (aliases.has(alias)) alias = `${base}-${suffix++}`;
    aliases.add(alias);
    return { environmentId: member.environmentId, threadId: member.threadId, alias };
  });
}

export function completeParticipantDraft(current: ParticipantDraft, sentRevision: string) {
  return current.revision === sentRevision ? EMPTY_PARTICIPANT_DRAFT : current;
}
