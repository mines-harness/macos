import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type ContactProfile, type ContactsSnapshot } from "@t3tools/contracts/contacts";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import { signSharedGroupAccessProof } from "@t3tools/shared/minesSharedGroupAccess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Contacts from "./Contacts.ts";
import * as ContactsStore from "./ContactsStore.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";

const owner = createPeerIdentity(new Uint8Array(32).fill(11), "Coordinator");
const guest = createPeerIdentity(new Uint8Array(32).fill(12), "Guest");
const other = createPeerIdentity(new Uint8Array(32).fill(13), "Other guest");
const people = new Map<string, ContactProfile>([
  ["owner", { friendId: "mines-11111111111111111111", displayName: "Owner", avatar: null }],
  ["guest", { friendId: "mines-22222222222222222222", displayName: "Guest", avatar: null }],
  ["other", { friendId: "mines-33333333333333333333", displayName: "Other", avatar: null }],
]);

function fixture() {
  const group: ContactsStore.StoredGroupMembership = {
    groupKey: "shared-group-key-0001",
    groupId: "local-group-id",
    groupName: "Shared work",
    ownerAccountId: "owner",
    coordinatorEnvironmentId: "host-environment",
    coordinatorDeviceId: owner.device.deviceId,
    updatedAt: "2026-10-26T00:00:00.000Z",
    members: ["owner"],
  };
  const members = ["owner"];
  const devices = new Map([
    [owner.device.deviceId, { accountId: "owner", device: owner.device }],
    [guest.device.deviceId, { accountId: "guest", device: guest.device }],
    [other.device.deviceId, { accountId: "other", device: other.device }],
  ]);
  const contacts = new Set<string>();
  const invites: ContactsStore.StoredGroupInvitationInput[] = [];
  const updates: Array<{ displayName: string; avatar: string | null }> = [];
  const snapshot = (accountId: string): ContactsSnapshot => ({
    profile: people.get(accountId)!,
    contacts: [],
    invitations: [],
    groups: [],
  });
  const store = Layer.mock(ContactsStore.ContactsStore, {
    ensureProfile: (accountId) => Effect.succeed(people.get(accountId)!),
    snapshot: (accountId) => Effect.succeed(snapshot(accountId)),
    findProfile: (friendId) =>
      Effect.succeed(
        [...people]
          .map(([accountId, profile]) => ({ accountId, profile }))
          .find((entry) => entry.profile.friendId === friendId) ?? null,
      ),
    isContact: (accountId, targetAccountId) =>
      Effect.succeed(contacts.has(`${accountId}:${targetAccountId}`)),
    groupMembers: (key) =>
      Effect.succeed(key === group.groupKey ? { ...group, members: [...members] } : null),
    invite: (input) =>
      Effect.sync(() => {
        invites.push(input);
      }),
    updateProfile: (_, input) =>
      Effect.sync(() => {
        updates.push(input);
      }),
  });
  const directory = Layer.mock(DeviceDirectory.DeviceDirectory, {
    owner: (id) =>
      Effect.sync(() => {
        const value = devices.get(id);
        return value
          ? Option.some({ accountId: value.accountId, publicKey: value.device.publicKey })
          : Option.none();
      }),
    list: (accountId) =>
      Effect.succeed(
        [...devices.values()]
          .filter((entry) => entry.accountId === accountId)
          .map((entry) => entry.device),
      ),
  });
  return {
    members,
    devices,
    contacts,
    invites,
    updates,
    group,
    service: Contacts.Contacts.pipe(
      Effect.provide(
        Contacts.layer.pipe(Layer.provide(Layer.mergeAll(store, directory, NodeCrypto.layer))),
      ),
    ),
  };
}

it.effect("requires accepted membership and rechecks leave or revoke for every group access", () =>
  Effect.gen(function* () {
    const state = fixture();
    const service = yield* state.service;
    const input = {
      groupKey: state.group.groupKey,
      fromDeviceId: owner.device.deviceId,
      toDeviceId: guest.device.deviceId,
    };
    expect((yield* Effect.flip(service.groupAccess("owner", input))).code).toBe("forbidden");
    state.members.push("guest");
    const grant = yield* service.groupAccess("owner", input);
    expect(grant.from).toEqual(owner.device);
    expect(grant.to).toEqual(guest.device);
    expect(grant.fromFriendId).toBe(people.get("owner")!.friendId);
    expect(grant.toFriendId).toBe(people.get("guest")!.friendId);
    expect(JSON.stringify(grant)).not.toContain("accountId");
    state.members.splice(state.members.indexOf("guest"), 1);
    expect((yield* Effect.flip(service.groupAccess("owner", input))).code).toBe("forbidden");
  }),
);

it.effect("binds group access to the signed-in source device and coordinator star topology", () =>
  Effect.gen(function* () {
    const state = fixture();
    state.members.push("guest", "other");
    const service = yield* state.service;
    const input = {
      groupKey: state.group.groupKey,
      fromDeviceId: owner.device.deviceId,
      toDeviceId: guest.device.deviceId,
    };
    expect((yield* Effect.flip(service.groupAccess("guest", input))).code).toBe("forbidden");
    expect(
      (yield* Effect.flip(
        service.groupAccess("guest", {
          ...input,
          fromDeviceId: guest.device.deviceId,
          toDeviceId: other.device.deviceId,
        }),
      )).code,
    ).toBe("forbidden");
    expect(
      (yield* service.groupAccess("guest", {
        ...input,
        fromDeviceId: guest.device.deviceId,
        toDeviceId: owner.device.deviceId,
      })).to,
    ).toEqual(owner.device);
    state.devices.delete(owner.device.deviceId);
    expect(
      (yield* Effect.flip(
        service.groupAccess("guest", {
          ...input,
          fromDeviceId: guest.device.deviceId,
          toDeviceId: owner.device.deviceId,
        }),
      )).code,
    ).toBe("forbidden");
  }),
);

it.effect("only invites a saved contact through a coordinator owned by the signed-in account", () =>
  Effect.gen(function* () {
    const state = fixture();
    const service = yield* state.service;
    const input = {
      clientRequestId: "invite-request",
      friendId: people.get("guest")!.friendId,
      groupId: state.group.groupId,
      groupName: state.group.groupName,
      coordinatorEnvironmentId: state.group.coordinatorEnvironmentId,
      coordinatorDeviceId: owner.device.deviceId,
    };
    expect((yield* Effect.flip(service.invite("owner", input))).code).toBe("forbidden");
    state.contacts.add("owner:guest");
    expect(
      (yield* Effect.flip(
        service.invite("owner", { ...input, coordinatorDeviceId: guest.device.deviceId }),
      )).code,
    ).toBe("forbidden");
    expect(state.invites).toHaveLength(0);
    yield* service.invite("owner", input);
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0]?.targetAccountId).toBe("guest");
    expect(state.members).toEqual(["owner"]);
  }),
);

it.effect("rejects SVG, HTML and mislabeled raster avatars without storing them", () =>
  Effect.gen(function* () {
    const state = fixture();
    const service = yield* state.service;
    for (const avatar of [
      "data:image/svg+xml;base64,PHN2Zy8+",
      "javascript:alert(1)",
      "data:image/png;base64,PHN2Zy8+",
    ])
      expect(
        (yield* Effect.flip(service.updateProfile("owner", { displayName: "Owner", avatar }))).code,
      ).toBe("invalid-input");
    expect(state.updates).toEqual([]);
    yield* service.updateProfile("owner", { displayName: "Owner", avatar: null });
    expect(state.updates).toEqual([{ displayName: "Owner", avatar: null }]);
  }),
);

it.effect("accepts only fresh single-use device proofs and rechecks current membership", () =>
  Effect.gen(function* () {
    const state = fixture();
    const service = yield* state.service;
    const input = {
      groupKey: state.group.groupKey,
      toDeviceId: guest.device.deviceId,
      issuedAt: 0,
      nonce: "shared-proof-nonce-0001",
    };
    state.members.push("guest");
    const proof = signSharedGroupAccessProof(owner, input);
    expect((yield* service.deviceGroupAccess(proof)).to).toEqual(guest.device);
    expect((yield* Effect.flip(service.deviceGroupAccess(proof))).code).toBe("forbidden");
    expect(
      (yield* Effect.flip(
        service.deviceGroupAccess({ ...proof, groupKey: "another-group-key-0001" }),
      )).code,
    ).toBe("forbidden");
    state.members.splice(state.members.indexOf("guest"), 1);
    expect(
      (yield* Effect.flip(
        service.deviceGroupAccess(
          signSharedGroupAccessProof(owner, { ...input, nonce: "shared-proof-nonce-0002" }),
        ),
      )).code,
    ).toBe("forbidden");
    state.members.push("guest");
    yield* TestClock.adjust("62 seconds");
    expect(
      (yield* Effect.flip(
        service.deviceGroupAccess(
          signSharedGroupAccessProof(owner, { ...input, nonce: "shared-proof-nonce-0003" }),
        ),
      )).code,
    ).toBe("forbidden");
  }),
);

it.effect(
  "allows a coordinator to resolve its own group without granting a participant self access",
  () =>
    Effect.gen(function* () {
      const state = fixture();
      const service = yield* state.service;
      const input = {
        groupKey: state.group.groupKey,
        fromDeviceId: owner.device.deviceId,
        toDeviceId: owner.device.deviceId,
      };
      expect((yield* service.groupAccess("owner", input)).coordinatorDevice).toEqual(owner.device);
      state.members.push("guest");
      expect(
        (yield* Effect.flip(
          service.groupAccess("guest", {
            ...input,
            fromDeviceId: guest.device.deviceId,
            toDeviceId: guest.device.deviceId,
          }),
        )).code,
      ).toBe("forbidden");
    }),
);
