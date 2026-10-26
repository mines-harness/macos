import {
  ContactFriendInput as ContactFriendSchema,
  ContactGroupAccessInput as ContactAccessSchema,
  ContactGroupCreateInput as ContactGroupSchema,
  ContactGroupInviteInput as ContactInviteSchema,
  ContactProfileUpdate as ContactProfileSchema,
  CONTACT_AVATAR_MAX_BYTES,
  ContactsError,
  ContactsGroupAccessProof,
  GroupInvitationAction as InvitationActionSchema,
} from "@t3tools/contracts/contacts";
import type {
  ContactFriendInput,
  ContactGroupAccessInput,
  ContactGroupCreateInput,
  ContactGroupInviteInput,
  ContactProfileUpdate,
  ContactsSnapshot,
  GroupInvitationAction,
  SharedGroupDeviceGrant,
} from "@t3tools/contracts/contacts";
import { verifySharedGroupAccessProof } from "@t3tools/shared/minesSharedGroupAccess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ContactsStore from "./ContactsStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";

const decodeFriend = Schema.decodeEffect(ContactFriendSchema);
const decodeAccess = Schema.decodeEffect(ContactAccessSchema);
const decodeGroup = Schema.decodeEffect(ContactGroupSchema);
const decodeInvite = Schema.decodeEffect(ContactInviteSchema);
const decodeProfile = Schema.decodeEffect(ContactProfileSchema);
const decodeAction = Schema.decodeEffect(InvitationActionSchema);
const decodeProof = Schema.decodeUnknownEffect(ContactsGroupAccessProof);

export class Contacts extends Context.Service<
  Contacts,
  {
    readonly snapshot: (accountId: string) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly updateProfile: (
      accountId: string,
      input: ContactProfileUpdate,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly addContact: (
      accountId: string,
      input: ContactFriendInput,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly removeContact: (
      accountId: string,
      input: ContactFriendInput,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly registerGroup: (
      accountId: string,
      input: ContactGroupCreateInput,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly invite: (
      accountId: string,
      input: ContactGroupInviteInput,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly transition: (
      accountId: string,
      invitationId: string,
      action: GroupInvitationAction,
    ) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly groupAccess: (
      accountId: string,
      input: ContactGroupAccessInput,
    ) => Effect.Effect<SharedGroupDeviceGrant, ContactsError>;
    readonly deviceGroupAccess: (
      proof: unknown,
    ) => Effect.Effect<SharedGroupDeviceGrant, ContactsError>;
  }
>()("@mines/control/Contacts") {}

function rasterAvatar(avatar: string | null): boolean {
  if (avatar === null || avatar.startsWith("https://")) return true;
  const comma = avatar.indexOf(",");
  const bytes = Buffer.from(avatar.slice(comma + 1), "base64");
  if (bytes.length === 0 || bytes.length > CONTACT_AVATAR_MAX_BYTES) return false;
  if (avatar.startsWith("data:image/png;"))
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (avatar.startsWith("data:image/jpeg;"))
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (avatar.startsWith("data:image/gif;"))
    return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  return (
    avatar.startsWith("data:image/webp;") &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export const layer = Layer.effect(
  Contacts,
  Effect.gen(function* () {
    const store = yield* ContactsStore.ContactsStore;
    const directory = yield* DeviceDirectory.DeviceDirectory;
    const crypto = yield* Crypto.Crypto;
    const proofs = new Map<string, number>();
    const forbidden = () => new ContactsError({ code: "forbidden" });
    const invalid = () => new ContactsError({ code: "invalid-input" });
    const uuid = crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(() => new ContactsError({ code: "storage" })));
    const ensureProfile = Effect.fn("Contacts.ensureProfile")(function* (accountId: string) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = `mines-${(yield* uuid).replaceAll("-", "").slice(0, 20)}`;
        const profile = yield* store.ensureProfile(accountId, id).pipe(
          Effect.catchIf(
            (error) => error.code === "conflict",
            () => Effect.succeed(null),
          ),
        );
        if (profile) return profile;
      }
      return yield* new ContactsError({ code: "storage" });
    });
    const snapshot = Effect.fn("Contacts.snapshot")(function* (accountId: string) {
      yield* ensureProfile(accountId);
      return yield* store.snapshot(accountId);
    });
    const targetAccount = Effect.fn("Contacts.targetAccount")(function* (
      accountId: string,
      friendId: string,
    ) {
      const target = yield* store.findProfile(friendId);
      if (!target) return yield* new ContactsError({ code: "not-found" });
      if (target.accountId === accountId) return yield* invalid();
      return target.accountId;
    });
    const coordinator = Effect.fn("Contacts.coordinator")(function* (
      accountId: string,
      deviceId: string,
    ) {
      const owner = yield* directory.owner(deviceId).pipe(Effect.mapError(forbidden));
      if (Option.isNone(owner) || owner.value.accountId !== accountId) return yield* forbidden();
    });
    const groupAccess = Effect.fn("Contacts.groupAccess")(function* (
      accountId: string,
      value: ContactGroupAccessInput,
    ) {
      const input = yield* decodeAccess(value).pipe(Effect.mapError(invalid));
      const group = yield* store.groupMembers(input.groupKey);
      if (
        !group ||
        (input.fromDeviceId === input.toDeviceId &&
          input.fromDeviceId !== group.coordinatorDeviceId) ||
        (input.fromDeviceId !== group.coordinatorDeviceId &&
          input.toDeviceId !== group.coordinatorDeviceId)
      )
        return yield* forbidden();
      const [fromOwner, toOwner, coordinatorOwner] = yield* Effect.all([
        directory.owner(input.fromDeviceId),
        directory.owner(input.toDeviceId),
        directory.owner(group.coordinatorDeviceId),
      ]).pipe(Effect.mapError(forbidden));
      if (
        Option.isNone(fromOwner) ||
        Option.isNone(toOwner) ||
        Option.isNone(coordinatorOwner) ||
        fromOwner.value.accountId !== accountId ||
        coordinatorOwner.value.accountId !== group.ownerAccountId ||
        !group.members.includes(fromOwner.value.accountId) ||
        !group.members.includes(toOwner.value.accountId)
      )
        return yield* forbidden();
      const [fromDevices, toDevices, coordinatorDevices] = yield* Effect.all([
        directory.list(fromOwner.value.accountId),
        directory.list(toOwner.value.accountId),
        directory.list(group.ownerAccountId),
      ]).pipe(Effect.mapError(forbidden));
      const from = fromDevices.find(
        (device) =>
          device.deviceId === input.fromDeviceId && device.publicKey === fromOwner.value.publicKey,
      );
      const to = toDevices.find(
        (device) =>
          device.deviceId === input.toDeviceId && device.publicKey === toOwner.value.publicKey,
      );
      const coordinatorDevice = coordinatorDevices.find(
        (device) =>
          device.deviceId === group.coordinatorDeviceId &&
          device.publicKey === coordinatorOwner.value.publicKey,
      );
      if (!from || !to || !coordinatorDevice) return yield* forbidden();
      const [fromProfile, toProfile] = yield* Effect.all([
        ensureProfile(fromOwner.value.accountId),
        ensureProfile(toOwner.value.accountId),
      ]);
      return {
        groupKey: group.groupKey,
        groupId: group.groupId,
        coordinatorEnvironmentId: group.coordinatorEnvironmentId,
        coordinatorDevice,
        from,
        to,
        fromFriendId: fromProfile.friendId,
        toFriendId: toProfile.friendId,
        updatedAt: group.updatedAt,
      };
    });
    return Contacts.of({
      snapshot,
      updateProfile: Effect.fn("Contacts.updateProfile")(function* (accountId, value) {
        const input = yield* decodeProfile(value).pipe(Effect.mapError(invalid));
        if (!rasterAvatar(input.avatar)) return yield* invalid();
        yield* ensureProfile(accountId);
        yield* store.updateProfile(accountId, { ...input, displayName: input.displayName.trim() });
        return yield* store.snapshot(accountId);
      }),
      addContact: Effect.fn("Contacts.addContact")(function* (accountId, value) {
        const input = yield* decodeFriend(value).pipe(Effect.mapError(invalid));
        yield* ensureProfile(accountId);
        yield* store.addContact(accountId, yield* targetAccount(accountId, input.friendId));
        return yield* store.snapshot(accountId);
      }),
      removeContact: Effect.fn("Contacts.removeContact")(function* (accountId, value) {
        const input = yield* decodeFriend(value).pipe(Effect.mapError(invalid));
        yield* ensureProfile(accountId);
        yield* store.removeContact(accountId, yield* targetAccount(accountId, input.friendId));
        return yield* store.snapshot(accountId);
      }),
      registerGroup: Effect.fn("Contacts.registerGroup")(function* (accountId, value) {
        const input = yield* decodeGroup(value).pipe(Effect.mapError(invalid));
        yield* ensureProfile(accountId);
        yield* coordinator(accountId, input.coordinatorDeviceId);
        yield* store.registerGroup({ ...input, accountId, groupKey: yield* uuid });
        return yield* store.snapshot(accountId);
      }),
      invite: Effect.fn("Contacts.invite")(function* (accountId, value) {
        const input = yield* decodeInvite(value).pipe(Effect.mapError(invalid));
        yield* ensureProfile(accountId);
        yield* coordinator(accountId, input.coordinatorDeviceId);
        const targetAccountId = yield* targetAccount(accountId, input.friendId);
        if (!(yield* store.isContact(accountId, targetAccountId))) return yield* forbidden();
        yield* store.invite({
          ...input,
          accountId,
          targetAccountId,
          groupKey: yield* uuid,
          invitationId: yield* uuid,
        });
        return yield* store.snapshot(accountId);
      }),
      transition: Effect.fn("Contacts.transition")(function* (accountId, invitationId, action) {
        yield* decodeAction(action).pipe(Effect.mapError(invalid));
        if (!invitationId.trim() || invitationId.length > 160) return yield* invalid();
        yield* ensureProfile(accountId);
        yield* store.transition(accountId, invitationId, action);
        return yield* store.snapshot(accountId);
      }),
      groupAccess,
      deviceGroupAccess: Effect.fn("Contacts.deviceGroupAccess")(function* (value) {
        const input = yield* decodeProof(value).pipe(Effect.mapError(forbidden));
        const owner = yield* directory.owner(input.fromDeviceId).pipe(Effect.mapError(forbidden));
        if (Option.isNone(owner)) return yield* forbidden();
        const devices = yield* directory
          .list(owner.value.accountId)
          .pipe(Effect.mapError(forbidden));
        const device = devices.find(
          (entry) =>
            entry.deviceId === input.fromDeviceId && entry.publicKey === owner.value.publicKey,
        );
        if (!device) return yield* forbidden();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const proof = yield* Effect.try({
          try: () => verifySharedGroupAccessProof(value, device, now),
          catch: forbidden,
        });
        for (const [key, expiresAt] of proofs) if (expiresAt < now) proofs.delete(key);
        const key = `${proof.fromDeviceId}:${proof.nonce}`;
        if (proofs.has(key) || proofs.size >= 10_000) return yield* forbidden();
        proofs.set(key, proof.issuedAt + 61);
        return yield* groupAccess(owner.value.accountId, proof);
      }),
    });
  }),
);
