import {
  type GroupDelivery,
  type GroupMember,
  type GroupMessage,
  type GroupRound,
  type GroupSendInput,
} from "@t3tools/contracts";

const GROUP_LIMITS = { handoffHops: 3, handoffDeliveries: 6, turnsPerMember: 2 } as const;
const settled = new Set<GroupDelivery["status"]>([
  "completed",
  "silent",
  "unavailable",
  "failed",
  "cancelled",
]);
export const isDeliverySettled = (delivery: GroupDelivery) => settled.has(delivery.status);

export function routeGroupMessage(
  input: GroupSendInput,
  members: ReadonlyArray<GroupMember>,
): {
  readonly routing: GroupRound["routing"];
  readonly memberIds: ReadonlyArray<string>;
} {
  const visibleText = input.message.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const aliases = [...visibleText.matchAll(/(?:^|[^\w\\])@([A-Za-z][A-Za-z0-9_-]*)\b/g)].map(
    (match) => match[1]!.toLowerCase(),
  );
  if (input.mentionEveryone || aliases.includes("everyone"))
    return { routing: "everyone", memberIds: members.map((member) => member.id) };
  const ids =
    input.recipientMemberIds ??
    members
      .filter((member) => aliases.includes(member.alias.toLowerCase()))
      .map((member) => member.id);
  return ids.length > 0
    ? { routing: "targeted", memberIds: [...new Set(ids)] }
    : { routing: "self-select", memberIds: members.map((member) => member.id) };
}

export function handoffRefusal(
  round: GroupRound,
  source: GroupDelivery,
  targetId: string,
): string | null {
  if (round.status !== "active") return "This discussion has already ended.";
  if (round.routing === "everyone" || round.workflow !== "team")
    return "This message has a fixed response schedule; additional discussion is disabled.";
  if (source.memberId === targetId) return "A member cannot hand a group request to itself.";
  if (!round.members.some((member) => member.id === targetId))
    return "That member is not part of this round.";
  if (source.hop >= GROUP_LIMITS.handoffHops)
    return "This discussion has reached its three-hop limit.";
  if (
    round.deliveries.filter((delivery) => delivery.stage === "handoff").length >=
    GROUP_LIMITS.handoffDeliveries
  )
    return "This discussion has reached its six-handoff limit.";
  if (
    round.deliveries.filter((delivery) => delivery.memberId === targetId).length >=
    GROUP_LIMITS.turnsPerMember
  )
    return "That member has reached its two-turn limit for this message.";
  const ancestors = new Set<string>();
  let current: GroupDelivery | undefined = source;
  while (current) {
    ancestors.add(current.memberId);
    current = round.deliveries.find((delivery) => delivery.id === current?.parentDeliveryId);
  }
  return ancestors.has(targetId)
    ? "A handoff cannot return to an earlier member in the same chain."
    : null;
}

export function nextWorkflowStage(
  round: GroupRound,
  leadMemberId: string,
): { readonly stage: GroupDelivery["stage"]; readonly memberIds: ReadonlyArray<string> } | null {
  if (
    round.routing !== "workflow" ||
    round.deliveries.some((delivery) => !isDeliverySettled(delivery))
  )
    return null;
  if (round.deliveries.some((delivery) => delivery.status !== "completed")) return null;
  const last = round.deliveries.at(-1)?.stage;
  if (round.workflow === "build-review") {
    if (last === "initial")
      return {
        stage: "review",
        memberIds: round.members
          .filter((member) => member.id !== leadMemberId)
          .map((member) => member.id),
      };
    if (last === "review") return { stage: "fix", memberIds: [leadMemberId] };
  }
  if (round.workflow === "council") {
    if (last === "initial")
      return {
        stage: "critique",
        memberIds: round.members
          .filter((member) => member.id !== leadMemberId)
          .map((member) => member.id),
      };
    if (last === "critique") return { stage: "synthesis", memberIds: [leadMemberId] };
  }
  return null;
}

export function renderGroupContext(
  members: ReadonlyArray<GroupMember>,
  messages: ReadonlyArray<GroupMessage>,
): string {
  const roster = members
    .map(
      (member) =>
        `@${member.alias} (memberId=${member.id}, thread=${member.threadId}): ${member.role || member.alias}`,
    )
    .join("\n");
  let budget = 24_000;
  const parts: string[] = [];
  for (const message of messages.toReversed()) {
    if (budget <= 0) break;
    const author =
      message.memberId === null
        ? "User"
        : `@${members.find((member) => member.id === message.memberId)?.alias ?? "former-member"}`;
    const part = `${author} [${message.kind}]: ${message.text.slice(0, Math.min(8_000, budget))}`;
    parts.unshift(part);
    budget -= part.length;
  }
  return `Group members:\n${roster}\n\nShared group messages (bounded recent context):\n${parts.join("\n\n")}`;
}
