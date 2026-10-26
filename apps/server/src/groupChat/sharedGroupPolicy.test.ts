import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sharedGroupEnvironmentId, sharedGroupMemberInputs } from "./sharedGroupPolicy.ts";

describe("shared group boundaries", () => {
  it("binds offered chats to their verified device, rejecting asserted local and other environments", () => {
    const local = EnvironmentId.make("coordinator");
    const route = sharedGroupEnvironmentId("group-key-12345678", "friend-device");
    const member = { threadId: ThreadId.make("same-thread-id"), alias: "writer" };
    expect(sharedGroupMemberInputs([member], route)).toEqual([{ ...member, environmentId: route }]);
    expect(route).not.toBe(local);
    expect(route).not.toBe(sharedGroupEnvironmentId("other-group-12345678", "friend-device"));
    expect(route).not.toBe(sharedGroupEnvironmentId("group-key-12345678", "other-device"));
    for (const environmentId of [local, EnvironmentId.make("another-friend"), route])
      expect(() => sharedGroupMemberInputs([{ ...member, environmentId }], route)).toThrow();
  });
});
