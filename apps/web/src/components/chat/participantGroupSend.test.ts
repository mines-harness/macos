import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, GroupId, ThreadId, type GroupSnapshot } from "@t3tools/contracts";
import { submitParticipantGroup } from "./participantGroupSend";

const environmentId = EnvironmentId.make("mac");
const snapshot: GroupSnapshot = {
  group: {
    id: GroupId.make("team"),
    name: "Build it",
    workflow: "team",
    leadMemberId: "lead",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    archivedAt: null,
  },
  members: [],
  messages: [],
  rounds: [],
  hasMoreMessages: false,
};
const input = {
  environmentId,
  members: [{ environmentId, threadId: ThreadId.make("design"), title: "Design" }],
  title: "Build it",
  message: "Build it with the selected mines",
  requestId: "retained-request",
};

describe("participant group submission", () => {
  it("sends the initial prompt to selected existing mines and reuses both receipt ids after a lost send response", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockResolvedValueOnce(undefined);
    await expect(submitParticipantGroup(input, { create, send })).rejects.toThrow("Response lost");
    await expect(submitParticipantGroup(input, { create, send })).resolves.toBe(snapshot);
    expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(create).toHaveBeenLastCalledWith({
      name: "Build it",
      workflow: "team",
      members: [{ environmentId, threadId: input.members[0]!.threadId, alias: "design" }],
      leadThreadId: input.members[0]!.threadId,
      leadEnvironmentId: environmentId,
      clientRequestId: "retained-request",
    });
    expect(send).toHaveBeenLastCalledWith({
      groupId: snapshot.group.id,
      message: input.message,
      mentionEveryone: true,
      clientRequestId: "retained-request",
    });
  });

  it("does not send a prompt when the group could not be created", async () => {
    const create = vi.fn().mockRejectedValue(new Error("This mine is already grouped"));
    const send = vi.fn();
    await expect(submitParticipantGroup(input, { create, send })).rejects.toThrow(
      "already grouped",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the group creation receipt while a changed prompt gets its own send receipt", async () => {
    const create = vi.fn().mockResolvedValue(snapshot);
    const send = vi.fn().mockResolvedValue(undefined);
    await submitParticipantGroup({ ...input, sendRequestId: "first-message" }, { create, send });
    await submitParticipantGroup(
      { ...input, message: "An edited message", sendRequestId: "edited-message" },
      { create, send },
    );
    expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
    expect(send.mock.calls[0]?.[0].clientRequestId).toBe("first-message");
    expect(send.mock.calls[1]?.[0]).toEqual({
      groupId: snapshot.group.id,
      message: "An edited message",
      mentionEveryone: true,
      clientRequestId: "edited-message",
    });
  });
});
