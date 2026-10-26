import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  availableGroupParticipants,
  groupMemberKey,
  groupMembershipLabels,
  nextGroupAlias,
} from "./groupParticipants";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ThreadId.make(id),
  archivedAt: null,
  lineage: { relationshipToParent: null },
});

describe("mobile group participant selection", () => {
  it("labels active memberships on the correct computer and ignores archived groups", () => {
    const labels = groupMembershipLabels([
      {
        environmentId: local,
        groups: [
          { id: "group-a", name: "Launch team", archivedAt: null },
          { id: "archived", name: "Old team", archivedAt: "2026-10-26" },
          { id: "shared", name: "Friends", archivedAt: null, visibility: "shared" },
        ],
        memberships: [
          { groupId: "group-a", threadId: "same-id", environmentId: null },
          { groupId: "group-a", threadId: "remote-id", environmentId: remote },
          { groupId: "archived", threadId: "old", environmentId: null },
          { groupId: "shared", threadId: "shared-mine", environmentId: null },
        ],
      },
    ]);
    expect(labels.get(groupMemberKey(local, "same-id"))).toEqual(["Launch team"]);
    expect(labels.get(groupMemberKey(remote, "same-id"))).toBeUndefined();
    expect(labels.get(groupMemberKey(remote, "remote-id"))).toEqual(["Launch team"]);
    expect(labels.get(groupMemberKey(local, "old"))).toBeUndefined();
    expect(labels.get(groupMemberKey(local, "shared-mine"))).toBeUndefined();
  });
  it("includes the coordinator and only connected routed computers", () => {
    const threads = [
      thread(local, "a"),
      thread(remote, "b"),
      thread(EnvironmentId.make("unrouted"), "c"),
    ];
    expect(
      availableGroupParticipants({
        threads,
        environmentId: local,
        routedHosts: new Set([remote]),
        connectedHosts: new Set([local, remote, EnvironmentId.make("unrouted")]),
        occupiedKeys: new Set(),
      }).map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(
      availableGroupParticipants({
        threads,
        environmentId: local,
        routedHosts: new Set([remote]),
        connectedHosts: new Set([local]),
        occupiedKeys: new Set(),
      }).map((item) => item.id),
    ).toEqual(["a"]);
  });

  it("excludes archived, subagent, and occupied mines with environment-scoped identities", () => {
    const threads = [
      thread(local, "same-id"),
      thread(remote, "same-id"),
      { ...thread(local, "archived"), archivedAt: "2026-10-26" },
      { ...thread(local, "child"), lineage: { relationshipToParent: "subagent" } },
    ];
    expect(
      availableGroupParticipants({
        threads,
        environmentId: local,
        routedHosts: new Set([remote]),
        connectedHosts: new Set([local, remote]),
        occupiedKeys: new Set([groupMemberKey(local, "same-id")]),
      }).map((item) => item.environmentId),
    ).toEqual([remote]);
  });

  it("suggests safe unique mention aliases without using the everyone mention", () => {
    expect(nextGroupAlias("Everyone", [])).toBe("teammate");
    expect(nextGroupAlias("Build & review", [{ alias: "BUILD-REVIEW" }])).toBe("build-review-2");
    expect(nextGroupAlias("123 🚀", [{ alias: "member" }])).toBe("member-2");
    expect(nextGroupAlias("a".repeat(80), [])).toHaveLength(24);
  });
});
