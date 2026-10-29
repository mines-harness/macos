import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  GroupId,
  type GroupDelivery,
  type GroupMember,
  type GroupRound,
} from "@t3tools/contracts/groupChat";
import { describe, expect, it } from "vite-plus/test";
import { groupActivity, groupPlanModeBlockReason, groupRecipients } from "./groupChat.ts";

const members = [
  { id: "a", alias: "Alice" },
  { id: "b", alias: "builder_2" },
];

it("checks Plan support only for addressed mines and preserves unknown old member capabilities", () => {
  const members = [
    { id: "plan", alias: "planner", supportsPlanMode: true },
    { id: "build", alias: "builder", supportsPlanMode: false },
  ];
  expect(groupPlanModeBlockReason("@planner Investigate", members)).toBeNull();
  expect(groupPlanModeBlockReason("Investigate", members)).toContain("@builder");
  expect(groupPlanModeBlockReason("@everyone Investigate", members)).toContain("@builder");
  expect(groupPlanModeBlockReason("`@builder` @planner Investigate", members)).toBeNull();
  expect(groupPlanModeBlockReason("Plan", [{ id: "old", alias: "old" }])).toBeNull();
  expect(groupPlanModeBlockReason("Plan", [])).toBe("Bring a mine to use Plan mode.");
});

describe("group addressing", () => {
  it("addresses real prose mentions once and ignores email fragments and escaped mentions", () => {
    expect(
      groupRecipients(
        "Don't skip @ALICE, @alice. Review (@builder_2) email@everyone \\@everyone",
        members,
      ),
    ).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a", "b"],
    });
  });
  it("ignores block quotes, quoted excerpts, inline code, and both fence styles", () => {
    const copied = [
      "> @everyone",
      '"@alice" and ‘@builder_2’',
      "`@everyone` and ``@alice``",
      "```js",
      "@everyone",
      "```",
      "~~~",
      "@alice",
      "~~~",
      "Ask @builder_2",
    ].join("\n");
    expect(groupRecipients(copied, members)).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["b"],
    });
  });
  it("does not route mentions in an unfinished code block", () => {
    expect(groupRecipients("@alice\n```\n@everyone", members)).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a"],
    });
  });
  it("keeps multiline quoted excerpts out of addressing", () => {
    expect(
      groupRecipients('He wrote "first line\n@everyone\nlast line"\nAsk @alice', members),
    ).toEqual({
      mentionEveryone: false,
      recipientMemberIds: ["a"],
    });
  });
  it("recognizes everyone outside quoted content", () => {
    expect(groupRecipients('"@alice" @everyone', members)).toEqual({
      mentionEveryone: true,
      recipientMemberIds: [],
    });
  });
});

const now = IsoDateTime.make("2026-10-29T10:00:00.000Z");
const member = (id: string): GroupMember => ({
  id,
  groupId: GroupId.make("group"),
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  environmentId: EnvironmentId.make("local"),
  alias: id,
  role: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  joinedAt: now,
});
const delivery = (
  memberId: string,
  status: GroupDelivery["status"],
  id = memberId,
): GroupDelivery => ({
  id,
  memberId,
  status,
  stage: "initial",
  runId: null,
  hop: 0,
  parentDeliveryId: null,
  request: "Review",
  contextThroughMessageId: null,
  error: null,
});
const round = (deliveries: readonly GroupDelivery[], active = true): GroupRound => ({
  id: "round",
  groupId: GroupId.make("group"),
  userMessageId: "message",
  routing: "everyone",
  workflow: "team",
  status: active ? "active" : "completed",
  members: [],
  deliveries,
  createdAt: now,
  completedAt: active ? null : now,
});

it("shows only current mines actually running in active rounds", () => {
  const members = [member("working"), member("waiting"), member("assessing")];
  expect(
    groupActivity(members, [
      round([
        delivery("working", "running"),
        delivery("working", "running", "duplicate"),
        delivery("waiting", "queued"),
        delivery("assessing", "assessing"),
        delivery("removed", "running"),
      ]),
      round([delivery("waiting", "running")], false),
    ]),
  ).toEqual([{ member: members[0], startedAt: null }]);
});

it("uses actual run start times and keeps old-server activity honest when unknown", () => {
  const members = [member("working"), member("old-server")];
  const startedAt = IsoDateTime.make("2026-10-29T10:03:00.000Z");
  expect(
    groupActivity(members, [
      round([{ ...delivery("working", "running"), startedAt }, delivery("old-server", "running")]),
    ]),
  ).toEqual([
    { member: members[0], startedAt },
    { member: members[1], startedAt: null },
  ]);
});
