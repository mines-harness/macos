import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PeerDevice } from "./minesPeer.ts";

export const ContactFriendId = Schema.String.check(Schema.isPattern(/^mines-[a-f0-9]{20}$/));
export const ContactGroupKey = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128));
const DeviceId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));

export const CONTACT_AVATAR_MAX_BYTES = 16_384;
export const CONTACT_AVATAR_MAX_LENGTH = 22_000;
export const CONTACT_GROUP_MAX_PEOPLE = 32;
export const ContactAvatar = Schema.NullOr(
  Schema.String.check(
    Schema.isMaxLength(CONTACT_AVATAR_MAX_LENGTH),
    Schema.makeFilter((value) => {
      if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
        return true;
      try {
        const url = new URL(value);
        return value.length <= 2048 && url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  ),
);

export const ContactProfile = Schema.Struct({
  friendId: ContactFriendId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  avatar: ContactAvatar,
});
export type ContactProfile = typeof ContactProfile.Type;

export const GroupInvitationStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "revoked",
  "left",
]);
const GroupFields = {
  groupId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  groupName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  coordinatorEnvironmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  coordinatorDeviceId: DeviceId,
};

export const GroupInvitation = Schema.Struct({
  id: RequestId,
  groupKey: ContactGroupKey,
  ...GroupFields,
  inviter: ContactProfile,
  invitee: ContactProfile,
  status: GroupInvitationStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GroupInvitation = typeof GroupInvitation.Type;

export const SharedContactGroup = Schema.Struct({
  key: ContactGroupKey,
  ...GroupFields,
  owner: ContactProfile,
  members: Schema.Array(ContactProfile).check(Schema.isMaxLength(CONTACT_GROUP_MAX_PEOPLE)),
  memberships: Schema.Array(
    Schema.Struct({
      invitationId: RequestId,
      friendId: ContactFriendId,
    }),
  ).check(Schema.isMaxLength(CONTACT_GROUP_MAX_PEOPLE - 1)),
});
export type SharedContactGroup = typeof SharedContactGroup.Type;

export const ContactsSnapshot = Schema.Struct({
  profile: ContactProfile,
  contacts: Schema.Array(ContactProfile),
  invitations: Schema.Array(GroupInvitation),
  groups: Schema.Array(SharedContactGroup),
});
export type ContactsSnapshot = typeof ContactsSnapshot.Type;

export const ContactProfileUpdate = Schema.Struct({
  displayName: ContactProfile.fields.displayName,
  avatar: ContactAvatar,
});
export type ContactProfileUpdate = typeof ContactProfileUpdate.Type;
export const ContactFriendInput = Schema.Struct({ friendId: ContactFriendId });
export type ContactFriendInput = typeof ContactFriendInput.Type;
export const ContactGroupCreateInput = Schema.Struct({
  clientRequestId: RequestId,
  ...GroupFields,
});
export type ContactGroupCreateInput = typeof ContactGroupCreateInput.Type;
export const ContactGroupInviteInput = Schema.Struct({
  ...ContactGroupCreateInput.fields,
  friendId: ContactFriendId,
});
export type ContactGroupInviteInput = typeof ContactGroupInviteInput.Type;
export const GroupInvitationAction = Schema.Literals(["accept", "decline", "revoke", "leave"]);
export type GroupInvitationAction = typeof GroupInvitationAction.Type;

export const ContactGroupAccessInput = Schema.Struct({
  groupKey: ContactGroupKey,
  fromDeviceId: DeviceId,
  toDeviceId: DeviceId,
});
export type ContactGroupAccessInput = typeof ContactGroupAccessInput.Type;
export const ContactsGroupAccessProof = Schema.Struct({
  ...ContactGroupAccessInput.fields,
  version: Schema.Literal(1),
  issuedAt: Schema.Int,
  nonce: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(80)),
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
});
export type ContactsGroupAccessProof = typeof ContactsGroupAccessProof.Type;
export const SharedGroupDeviceGrant = Schema.Struct({
  groupKey: ContactGroupKey,
  groupId: GroupFields.groupId,
  coordinatorEnvironmentId: GroupFields.coordinatorEnvironmentId,
  coordinatorDevice: PeerDevice,
  from: PeerDevice,
  to: PeerDevice,
  fromFriendId: ContactFriendId,
  toFriendId: ContactFriendId,
  updatedAt: IsoDateTime,
});
export type SharedGroupDeviceGrant = typeof SharedGroupDeviceGrant.Type;

export class ContactsError extends Schema.TaggedError<ContactsError>()("ContactsError", {
  code: Schema.Literals([
    "invalid-input",
    "not-found",
    "forbidden",
    "conflict",
    "limit",
    "storage",
  ]),
}) {
  override get message(): string {
    switch (this.code) {
      case "invalid-input":
        return "Check the contact or group details and try again.";
      case "not-found":
        return "This contact or invitation could not be found.";
      case "forbidden":
        return "This account cannot access this contact or group.";
      case "conflict":
        return "This invitation has changed. Refresh and try again.";
      case "limit":
        return `Shared groups can include up to ${CONTACT_GROUP_MAX_PEOPLE} people.`;
      case "storage":
        return "Contacts are temporarily unavailable. Try again shortly.";
    }
  }
}
