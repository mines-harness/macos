import { describe, expect, it, vi } from "vite-plus/test";
import { IsoDateTime } from "@t3tools/contracts";
import type { ContactsSnapshot } from "@t3tools/contracts/contacts";
import { contactGroupMembershipInvitationId } from "@t3tools/shared/minesContacts";
import { createMobileContactsState } from "./contactsState";

const profile = { friendId: "mines-00000000000000000000", displayName: "Me", avatar: null };
const friend = { friendId: "mines-11111111111111111111", displayName: "Friend", avatar: null };
const initial: ContactsSnapshot = {
  profile,
  contacts: [friend],
  groups: [],
  invitations: [
    {
      id: "invitation",
      groupKey: "shared-group-key-1",
      groupId: "group",
      groupName: "Friends",
      coordinatorEnvironmentId: "host",
      coordinatorDeviceId: "a".repeat(43),
      inviter: friend,
      invitee: profile,
      status: "pending",
      createdAt: IsoDateTime.make("2026-10-27T00:00:00.000Z"),
      updatedAt: IsoDateTime.make("2026-10-27T00:00:00.000Z"),
    },
  ],
};
const response = (value: ContactsSnapshot) => new Response(JSON.stringify(value));

describe("mobile contacts state", () => {
  it("loads invitations without accepting them and replaces state only after an explicit response", async () => {
    const accepted: ContactsSnapshot = {
      ...initial,
      invitations: [],
      groups: [
        {
          key: "shared-group-key-1",
          groupId: "group",
          groupName: "Friends",
          coordinatorEnvironmentId: "host",
          coordinatorDeviceId: "a".repeat(43),
          owner: friend,
          members: [friend, profile],
          memberships: [{ invitationId: "invitation", friendId: profile.friendId }],
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response(accepted));
    const state = createMobileContactsState({
      controlUrl: "https://control.example",
      getToken: async () => "test-session",
      fetch: fetcher,
    });
    expect(await state.refresh()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(state.getSnapshot().data?.groups).toEqual([]);
    expect(await state.run((client) => client.respond("invitation", "accept"))).toBe(true);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://control.example/v1/group-invitations/invitation/accept",
    );
    expect(state.getSnapshot().data?.groups[0]?.members).toEqual([friend, profile]);
    const saved = state.getSnapshot().data!;
    expect(
      contactGroupMembershipInvitationId(saved.groups[0]!, profile.friendId, saved.invitations),
    ).toBe("invitation");
    state.dispose();
  });

  it("does not send a mutation after its account is disposed while reading the token", async () => {
    const token = Promise.withResolvers<string | null>();
    const fetcher = vi.fn<typeof fetch>();
    const state = createMobileContactsState({
      controlUrl: "https://control.example",
      getToken: () => token.promise,
      fetch: fetcher,
    });
    const mutation = state.run((client) => client.addContact(friend.friendId));
    state.dispose();
    token.resolve("previous-account-session");
    expect(await mutation).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.getSnapshot().data).toBeNull();
  });

  it("keeps a mutation result when an older refresh completes later", async () => {
    const refreshStarted = Promise.withResolvers<void>();
    const oldResponse = Promise.withResolvers<Response>();
    const updated: ContactsSnapshot = { ...initial, contacts: [] };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "GET") {
        refreshStarted.resolve();
        return oldResponse.promise;
      }
      return response(updated);
    });
    const state = createMobileContactsState({
      controlUrl: "https://control.example",
      getToken: async () => "test-session",
      fetch: fetcher,
    });
    const refresh = state.refresh();
    await refreshStarted.promise;
    expect(await state.run((client) => client.removeContact(friend.friendId))).toBe(true);
    oldResponse.resolve(response(initial));
    expect(await refresh).toBe(false);
    expect(state.getSnapshot().data?.contacts).toEqual([]);
    state.dispose();
  });
});
