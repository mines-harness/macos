import type { GroupMemberInput } from "@t3tools/contracts/groupChat";
import type { ThreadId } from "@t3tools/contracts";

export function sharedChatMembers(
  threads: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>,
  existingAliases: ReadonlyArray<string>,
): ReadonlyArray<typeof GroupMemberInput.Type> {
  const used = new Set(existingAliases.map((alias) => alias.toLowerCase()));
  used.add("everyone");
  const ids = new Set<ThreadId>();
  return threads.flatMap((thread) => {
    if (ids.has(thread.id)) return [];
    ids.add(thread.id);
    const base =
      thread.title
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .replace(/-+$/, "")
        .slice(0, 28) || "mine";
    let alias = base;
    let suffix = 2;
    while (used.has(alias.toLowerCase())) alias = `${base}-${suffix++}`.slice(0, 32);
    used.add(alias.toLowerCase());
    return [{ threadId: thread.id, alias }];
  });
}
