import { describe, expect, it, vi } from "vite-plus/test";
import {
  createContactsClient,
  incomingContactInvitations,
  contactGroupMembershipInvitationId,
} from "./minesContacts.ts";

const profile = { friendId: "mines-11111111111111111111", displayName: "Alice", avatar: null };
const friend = { friendId: "mines-22222222222222222222", displayName: "Bob", avatar: null };
const invitation = {
  id: "invitation-1",
  groupKey: "shared_group_key_01",
  groupId: "group-1",
  groupName: "Friends",
  coordinatorEnvironmentId: "home",
  coordinatorDeviceId: "a".repeat(43),
  inviter: friend,
  invitee: profile,
  status: "pending" as const,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const snapshot = { profile, contacts: [friend], invitations: [invitation], groups: [] };
const options = {
  controlUrl: "https://accounts.mines.test/ignored?secret=no",
  getToken: async () => "account-token",
};

describe("Contacts account client", () => {
  it("loads invitations without accepting them and changes membership only through an explicit response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot)));
    const client = createContactsClient({ ...options, fetch: fetcher });
    const result = await client.snapshot();
    expect(incomingContactInvitations(result)).toEqual([invitation]);
    expect(result.groups).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe("https://accounts.mines.test/v1/contacts");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: { authorization: "Bearer account-token" },
    });
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...snapshot, invitations: [{ ...invitation, status: "declined" }] }),
      ),
    );
    await client.respond(invitation.id, "decline");
    expect(fetcher.mock.calls[1]?.[0].toString()).toBe(
      "https://accounts.mines.test/v1/group-invitations/invitation-1/decline",
    );
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
  });
  it("does not send a mutation if the account changes while its token is loading", async () => {
    let current = true;
    const fetcher = vi.fn<typeof fetch>();
    const client = createContactsClient({
      ...options,
      fetch: fetcher,
      isCurrent: () => current,
      getToken: async () => {
        current = false;
        return "old-account-token";
      },
    });
    await expect(client.addContact(friend.friendId)).rejects.toThrow("Your account changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("discards a response arriving after sign-out and rejects malformed profiles", async () => {
    let current = true;
    const client = createContactsClient({
      ...options,
      isCurrent: () => current,
      fetch: async () => {
        current = false;
        return new Response(JSON.stringify(snapshot));
      },
    });
    await expect(client.snapshot()).rejects.toThrow("Your account changed");
    const malformed = createContactsClient({
      ...options,
      fetch: async () =>
        new Response(
          JSON.stringify({ ...snapshot, profile: { ...profile, friendId: "internal-account-id" } }),
        ),
    });
    await expect(malformed.snapshot()).rejects.toThrow("unsupported response");
  });
  it("trims pasted friend IDs and keeps rejected requests out of the contact list", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private server failure", { status: 404 }));
    const client = createContactsClient({ ...options, fetch: fetcher });
    await expect(client.addContact(`  ${friend.friendId}  `)).rejects.toThrow(
      "friend ID or invitation is unavailable",
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ friendId: friend.friendId }));
  });
  it("shows the fixed group limit message instead of asking to refresh a stale invitation", async () => {
    const client = createContactsClient({
      ...options,
      fetch: async () =>
        Response.json({ error: "limit", message: "untrusted text" }, { status: 409 }),
    });
    await expect(client.respond("invite", "accept")).rejects.toThrow(
      "Shared groups can include up to 32 people.",
    );
  });
  it("keeps Leave and member revocation available after the full invitation leaves recent history", () => {
    const group = {
      key: invitation.groupKey,
      groupId: invitation.groupId,
      groupName: invitation.groupName,
      coordinatorEnvironmentId: invitation.coordinatorEnvironmentId,
      coordinatorDeviceId: invitation.coordinatorDeviceId,
      owner: friend,
      members: [profile, friend],
      memberships: [{ invitationId: invitation.id, friendId: profile.friendId }],
    };
    expect(contactGroupMembershipInvitationId(group, profile.friendId, [])).toBe(invitation.id);
    expect(contactGroupMembershipInvitationId(group, friend.friendId, [])).toBeNull();
    expect(
      contactGroupMembershipInvitationId({ ...group, memberships: [] }, profile.friendId, [
        { ...invitation, status: "accepted" },
      ]),
    ).toBe(invitation.id);
  });
  it("excludes outgoing, accepted and declined invitations from the inbox", () => {
    expect(
      incomingContactInvitations({
        ...snapshot,
        invitations: [
          invitation,
          { ...invitation, id: "outgoing", inviter: profile, invitee: friend },
          { ...invitation, id: "accepted", status: "accepted" },
          { ...invitation, id: "declined", status: "declined" },
        ],
      }),
    ).toEqual([invitation]);
  });
});
