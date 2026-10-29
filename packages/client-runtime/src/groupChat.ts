import type { GroupMember, GroupRound } from "@t3tools/contracts/groupChat";

export function groupPlanModeBlockReason(
  prompt: string,
  members: ReadonlyArray<Pick<GroupMember, "id" | "alias" | "supportsPlanMode">>,
): string | null {
  if (members.length === 0) return "Bring a mine to use Plan mode.";
  const addressing = groupRecipients(prompt, members);
  const targets = new Set(addressing.recipientMemberIds);
  const unsupported = members.filter(
    (member) =>
      member.supportsPlanMode === false &&
      (addressing.mentionEveryone || targets.size === 0 || targets.has(member.id)),
  );
  return unsupported.length > 0
    ? `Plan mode is unavailable for ${unsupported.map((member) => `@${member.alias}`).join(", ")}. Choose other mines or exit Plan mode.`
    : null;
}

/** Only user-authored prose addresses members; copied excerpts do not dispatch work. */
export function groupRecipients(
  text: string,
  members: ReadonlyArray<{ id: string; alias: string }>,
) {
  let fence: { character: string; length: number } | null = null;
  const prose: string[] = [];
  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[0]!, length: marker.length };
      continue;
    }
    if (line.trimStart().startsWith(">")) continue;
    prose.push(line);
  }
  const proseText = prose.join("\n");
  let visible = "";
  for (let index = 0; index < proseText.length; index += 1) {
    const character = proseText[index]!;
    if (character === "\\") {
      visible += " ";
      index += 1;
      continue;
    }
    if (character === "`") {
      const run = /^`+/.exec(proseText.slice(index))![0];
      const close = proseText.indexOf(run, index + run.length);
      index = close < 0 ? proseText.length : close + run.length - 1;
      visible += " ";
      continue;
    }
    const closer = character === "“" ? "”" : character === "‘" ? "’" : character;
    if (
      (character === '"' || character === "“" || character === "‘" || character === "'") &&
      (character !== "'" || index === 0 || !/[A-Za-z0-9]/.test(proseText[index - 1]!))
    ) {
      let close = index + 1;
      for (; close < proseText.length; close += 1) {
        if (proseText[close] === "\\") close += 1;
        else if (proseText[close] === closer) break;
      }
      index = close;
      visible += " ";
      continue;
    }
    visible += character;
  }
  const names = new Set(
    Array.from(visible.matchAll(/(?:^|[\s([{,:;!?])@([A-Za-z][A-Za-z0-9_-]*)\b/g), (match) =>
      match[1]!.toLowerCase(),
    ),
  );
  return {
    mentionEveryone: names.has("everyone"),
    recipientMemberIds: members
      .filter((member) => names.has(member.alias.toLowerCase()))
      .map((member) => member.id),
  };
}

export function groupActivity(members: readonly GroupMember[], rounds: readonly GroupRound[]) {
  const running = new Map<string, string | null>();
  for (const round of rounds) {
    if (round.status !== "active") continue;
    for (const delivery of round.deliveries) {
      if (delivery.status !== "running") continue;
      const startedAt = delivery.startedAt ?? null;
      const previous = running.get(delivery.memberId);
      if (
        previous === undefined ||
        (startedAt !== null && (previous === null || startedAt < previous))
      )
        running.set(delivery.memberId, startedAt);
    }
  }
  return members.flatMap((member) =>
    running.has(member.id) ? [{ member, startedAt: running.get(member.id) ?? null }] : [],
  );
}
