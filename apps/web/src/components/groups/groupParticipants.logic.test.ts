import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { participantKey } from "../chat/draftParticipants";
import { indexGroupMemberships } from "./groupParticipants.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const groupId = GroupId.make("team");
const threadId = ThreadId.make("mine");

describe("group membership index", () => {
  it("keeps friend groups out of private mine membership navigation", () => {
    const sharedId = GroupId.make("friend-group");
    const index = indexGroupMemberships([
      {
        environmentId: local,
        groups: [
          { id: groupId, name: "Private team", archivedAt: null },
          { id: sharedId, name: "Friends", archivedAt: null, visibility: "shared" },
        ],
        memberships: [
          { groupId, threadId, environmentId: null },
          { groupId: sharedId, threadId, environmentId: null },
        ],
      },
    ]);
    expect(index.get(participantKey({ environmentId: local, threadId }))).toEqual([
      { environmentId: local, groupId, name: "Private team" },
    ]);
  });

  it("resolves local members against their coordinator and keeps remote mines distinct", () => {
    const index = indexGroupMemberships([
      {
        environmentId: local,
        groups: [{ id: groupId, name: "Build team", archivedAt: null }],
        memberships: [
          { groupId, threadId, environmentId: null },
          { groupId, threadId, environmentId: remote },
        ],
      },
    ]);
    const expected = [{ environmentId: local, groupId, name: "Build team" }];
    expect(index.size).toBe(2);
    expect(index.get(participantKey({ environmentId: local, threadId }))).toEqual(expected);
    expect(index.get(participantKey({ environmentId: remote, threadId }))).toEqual(expected);
  });

  it("releases archived memberships and ignores dangling or repeated refs", () => {
    const archivedGroupId = GroupId.make("archived");
    const index = indexGroupMemberships([
      {
        environmentId: local,
        groups: [
          { id: groupId, name: "Current team", archivedAt: null },
          { id: archivedGroupId, name: "Old team", archivedAt: "2026-10-25T00:00:00Z" },
        ],
        memberships: [
          { groupId, threadId, environmentId: null },
          { groupId, threadId, environmentId: null },
          { groupId: archivedGroupId, threadId, environmentId: remote },
          { groupId: GroupId.make("missing"), threadId, environmentId: remote },
        ],
      },
    ]);
    expect([...index.entries()]).toEqual([
      [
        participantKey({ environmentId: local, threadId }),
        [{ environmentId: local, groupId, name: "Current team" }],
      ],
    ]);
  });

  it("preserves each coordinator when stale remote snapshots report multiple groups", () => {
    const index = indexGroupMemberships(
      [local, remote].map((environmentId) => ({
        environmentId,
        groups: [{ id: groupId, name: `${environmentId} team`, archivedAt: null }],
        memberships: [{ groupId, threadId, environmentId: local }],
      })),
    );
    expect(index.get(participantKey({ environmentId: local, threadId }))).toEqual([
      { environmentId: local, groupId, name: "local team" },
      { environmentId: remote, groupId, name: "remote team" },
    ]);
  });
});
