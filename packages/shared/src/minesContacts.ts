import {
  ContactsError,
  ContactsSnapshot,
  type GroupInvitation,
  type SharedContactGroup,
} from "@t3tools/contracts/contacts";
import * as Schema from "effect/Schema";

export interface ContactsClientOptions {
  readonly controlUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly isCurrent?: () => boolean;
  readonly fetch?: typeof fetch;
}
export interface ContactGroupInput {
  readonly clientRequestId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorDeviceId: string;
}
const decodeSnapshot = Schema.decodeUnknownSync(ContactsSnapshot);
const isFailure = Schema.is(Schema.Struct({ error: ContactsError.fields.code }));

function endpoint(base: string, path: string) {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("The contacts service address is unavailable.");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

export function createContactsClient(options: ContactsClientOptions) {
  const ensureCurrent = () => {
    if (options.isCurrent?.() === false) throw new Error("Your account changed. Please try again.");
  };
  const request = async (path: string, body?: unknown) => {
    ensureCurrent();
    const token = await options.getToken();
    ensureCurrent();
    if (!token) throw new Error("Sign in to mines to use Contacts.");
    const response = await (options.fetch ?? globalThis.fetch)(endpoint(options.controlUrl, path), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    ensureCurrent();
    if (!response.ok) {
      let failure: unknown = null;
      try {
        const text = await response.text();
        if (text.length <= 4096) failure = JSON.parse(text);
      } catch {}
      ensureCurrent();
      if (isFailure(failure)) throw new ContactsError({ code: failure.error });
      if (response.status === 401) throw new Error("Sign in again to use Contacts.");
      if (response.status === 404) throw new Error("That friend ID or invitation is unavailable.");
      if (response.status === 409)
        throw new Error("This contact or invitation has changed. Refresh and try again.");
      if (response.status === 400)
        throw new Error("Check the friend ID or profile details and try again.");
      throw new Error("Contacts could not be updated. Please try again.");
    }
    const text = await response.text();
    ensureCurrent();
    if (text.length > 2_000_000) throw new Error("The contacts response is too large.");
    try {
      return decodeSnapshot(JSON.parse(text));
    } catch {
      throw new Error("The contacts service returned an unsupported response.");
    }
  };
  return {
    snapshot: () => request("/v1/contacts"),
    updateProfile: (input: { readonly displayName: string; readonly avatar: string | null }) =>
      request("/v1/contacts/profile", input),
    addContact: (friendId: string) => request("/v1/contacts/add", { friendId: friendId.trim() }),
    removeContact: (friendId: string) => request("/v1/contacts/remove", { friendId }),
    registerGroup: (input: ContactGroupInput) => request("/v1/contacts/groups", input),
    invite: (input: ContactGroupInput & { readonly friendId: string }) =>
      request("/v1/group-invitations", input),
    respond: (invitationId: string, action: "accept" | "decline" | "revoke" | "leave") =>
      request(`/v1/group-invitations/${encodeURIComponent(invitationId)}/${action}`, {}),
  };
}
export type ContactsClient = ReturnType<typeof createContactsClient>;
export function incomingContactInvitations(
  snapshot: ContactsSnapshot,
): ReadonlyArray<GroupInvitation> {
  return snapshot.invitations.filter(
    (invite) =>
      invite.status === "pending" && invite.invitee.friendId === snapshot.profile.friendId,
  );
}

export function contactGroupMembershipInvitationId(
  group: SharedContactGroup,
  friendId: string,
  invitations: ReadonlyArray<GroupInvitation>,
): string | null {
  return (
    (group.memberships ?? []).find((membership) => membership.friendId === friendId)
      ?.invitationId ??
    invitations.find(
      (invitation) =>
        invitation.groupKey === group.key &&
        invitation.invitee.friendId === friendId &&
        invitation.status === "accepted",
    )?.id ??
    null
  );
}
