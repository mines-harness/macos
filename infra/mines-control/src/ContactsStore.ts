import {
  CONTACT_GROUP_MAX_PEOPLE,
  ContactsError,
  type ContactProfile,
  type ContactsSnapshot,
  type GroupInvitation,
  type SharedContactGroup,
} from "@t3tools/contracts/contacts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface StoredGroupInput {
  readonly accountId: string;
  readonly clientRequestId: string;
  readonly groupKey: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorDeviceId: string;
}

export interface StoredGroupInvitationInput extends StoredGroupInput {
  readonly targetAccountId: string;
  readonly invitationId: string;
}

export interface StoredGroupMembership {
  readonly groupKey: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly ownerAccountId: string;
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorDeviceId: string;
  readonly updatedAt: string;
  readonly members: ReadonlyArray<string>;
}

export type ContactInvitationAction = "accept" | "decline" | "revoke" | "leave";

export class ContactsStore extends Context.Service<
  ContactsStore,
  {
    readonly initialize: Effect.Effect<void, ContactsError>;
    readonly ensureProfile: (
      accountId: string,
      friendId: string,
    ) => Effect.Effect<ContactProfile, ContactsError>;
    readonly updateProfile: (
      accountId: string,
      input: { readonly displayName: string; readonly avatar: string | null },
    ) => Effect.Effect<void, ContactsError>;
    readonly findProfile: (
      friendId: string,
    ) => Effect.Effect<
      { readonly accountId: string; readonly profile: ContactProfile } | null,
      ContactsError
    >;
    readonly isContact: (
      accountId: string,
      targetAccountId: string,
    ) => Effect.Effect<boolean, ContactsError>;
    readonly addContact: (
      accountId: string,
      targetAccountId: string,
    ) => Effect.Effect<void, ContactsError>;
    readonly removeContact: (
      accountId: string,
      targetAccountId: string,
    ) => Effect.Effect<void, ContactsError>;
    readonly snapshot: (accountId: string) => Effect.Effect<ContactsSnapshot, ContactsError>;
    readonly avatar: (
      friendId: string,
      version: string,
    ) => Effect.Effect<string | null, ContactsError>;
    readonly registerGroup: (input: StoredGroupInput) => Effect.Effect<void, ContactsError>;
    readonly invite: (input: StoredGroupInvitationInput) => Effect.Effect<void, ContactsError>;
    readonly transition: (
      accountId: string,
      invitationId: string,
      action: ContactInvitationAction,
    ) => Effect.Effect<void, ContactsError>;
    readonly groupMembers: (
      groupKey: string,
    ) => Effect.Effect<StoredGroupMembership | null, ContactsError>;
  }
>()("@mines/control/ContactsStore") {}

interface ProfileRow {
  readonly account_id: string;
  readonly friend_id: string;
  readonly display_name: string;
  readonly avatar: string | null;
  readonly avatar_version: string | null;
}

interface GroupRow {
  readonly group_key: string;
  readonly group_id: string;
  readonly group_name: string;
  readonly owner_account_id: string;
  readonly coordinator_environment_id: string;
  readonly coordinator_device_id: string;
  readonly updated_at: Date | string;
}

type InvitationStatus = GroupInvitation["status"];

interface InvitationRow extends GroupRow {
  readonly invitation_id: string;
  readonly invitee_account_id: string;
  readonly status: InvitationStatus;
  readonly created_at: Date | string;
  readonly invitation_updated_at: Date | string;
}

const profile = (row: ProfileRow, origin: string): ContactProfile => ({
  friendId: row.friend_id,
  displayName: row.display_name,
  avatar:
    row.avatar?.startsWith("data:image/") && row.avatar_version
      ? new URL(`/v1/contacts/avatars/${row.friend_id}/${row.avatar_version}`, origin).href
      : row.avatar,
});
const iso = (value: Date | string) => DateTime.formatIso(DateTime.makeUnsafe(value));
const isContactsError = Schema.is(ContactsError);
const storageError = (cause: unknown) =>
  isContactsError(cause) ? cause : new ContactsError({ code: "storage" });

function initialAvatar(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export const layer = (authURL: string) => {
  const origin = new URL(authURL);
  if (origin.protocol !== "https:")
    throw new Error("Contacts avatars require an HTTPS account URL.");
  const publicProfile = (row: ProfileRow) => profile(row, origin.origin);
  return Layer.effect(
    ContactsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readProfile = Effect.fn("ContactsStore.readProfile")(function* (accountId: string) {
        const rows =
          yield* sql<ProfileRow>`SELECT account_id, friend_id, display_name, avatar,md5(avatar) AS avatar_version FROM mines_contact_profiles WHERE account_id=${accountId}`;
        return rows[0] ?? null;
      });
      const lockOwner = Effect.fn("ContactsStore.lockOwner")(function* (input: StoredGroupInput) {
        const owners =
          yield* sql`SELECT account_id FROM mines_contact_profiles WHERE account_id=${input.accountId} FOR UPDATE`;
        if (!owners.length) return yield* new ContactsError({ code: "forbidden" });
        const devices =
          yield* sql`SELECT device_id FROM mines_devices WHERE device_id=${input.coordinatorDeviceId} AND account_id=${input.accountId} AND NOT revoked FOR SHARE`;
        if (!devices.length) return yield* new ContactsError({ code: "forbidden" });
      });
      const requestPayload = (input: StoredGroupInput, targetAccountId?: string) =>
        JSON.stringify({
          groupId: input.groupId,
          groupName: input.groupName,
          coordinatorEnvironmentId: input.coordinatorEnvironmentId,
          coordinatorDeviceId: input.coordinatorDeviceId,
          ...(targetAccountId === undefined ? {} : { targetAccountId }),
        });
      const alreadyApplied = Effect.fn("ContactsStore.alreadyApplied")(function* (
        input: StoredGroupInput,
        operation: "create" | "invite",
        payload: string,
      ) {
        const rows = yield* sql<{
          operation: string;
          payload: string;
        }>`SELECT operation, payload FROM mines_contact_requests WHERE account_id=${input.accountId} AND client_request_id=${input.clientRequestId}`;
        if (!rows[0]) return false;
        if (rows[0].operation !== operation || rows[0].payload !== payload)
          return yield* new ContactsError({ code: "conflict" });
        return true;
      });
      const upsertGroup = Effect.fn("ContactsStore.upsertGroup")(function* (
        input: StoredGroupInput,
      ) {
        const rows = yield* sql<{
          group_key: string;
        }>`INSERT INTO mines_contact_groups(group_key,owner_account_id,group_id,group_name,coordinator_environment_id,coordinator_device_id)
        VALUES(${input.groupKey},${input.accountId},${input.groupId},${input.groupName},${input.coordinatorEnvironmentId},${input.coordinatorDeviceId})
        ON CONFLICT(owner_account_id,coordinator_device_id,coordinator_environment_id,group_id)
        DO UPDATE SET group_name=EXCLUDED.group_name,updated_at=NOW() RETURNING group_key`;
        if (!rows[0]) return yield* new ContactsError({ code: "storage" });
        return rows[0].group_key;
      });
      const groupMembers = Effect.fn("ContactsStore.groupMembers")(function* (groupKey: string) {
        const groups = yield* sql<
          GroupRow & { members: string[]; people_count: number }
        >`SELECT g.group_key,g.group_id,g.group_name,g.owner_account_id,g.coordinator_environment_id,g.coordinator_device_id,g.updated_at,
          1+(SELECT COUNT(*)::int FROM mines_group_invitations i WHERE i.group_key=g.group_key AND i.status IN ('pending','accepted')) AS people_count,
          ARRAY(SELECT g.owner_account_id UNION SELECT i.invitee_account_id FROM mines_group_invitations i WHERE i.group_key=g.group_key AND i.status='accepted') AS members
          FROM mines_contact_groups g WHERE g.group_key=${groupKey}`;
        const group = groups[0];
        if (!group) return null;
        if (group.people_count > CONTACT_GROUP_MAX_PEOPLE)
          return yield* new ContactsError({ code: "limit" });
        return {
          groupKey: group.group_key,
          groupId: group.group_id,
          groupName: group.group_name,
          ownerAccountId: group.owner_account_id,
          coordinatorEnvironmentId: group.coordinator_environment_id,
          coordinatorDeviceId: group.coordinator_device_id,
          updatedAt: iso(group.updated_at),
          members: group.members,
        };
      }, Effect.mapError(storageError));
      return ContactsStore.of({
        initialize: Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS mines_contact_profiles(account_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,friend_id VARCHAR(26) UNIQUE NOT NULL,display_name VARCHAR(100) NOT NULL,avatar TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
          yield* sql`CREATE TABLE IF NOT EXISTS mines_contacts(account_id TEXT NOT NULL REFERENCES mines_contact_profiles(account_id) ON DELETE CASCADE,target_account_id TEXT NOT NULL REFERENCES mines_contact_profiles(account_id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(account_id,target_account_id),CHECK(account_id<>target_account_id))`;
          yield* sql`CREATE TABLE IF NOT EXISTS mines_contact_groups(group_key TEXT PRIMARY KEY,owner_account_id TEXT NOT NULL REFERENCES mines_contact_profiles(account_id) ON DELETE CASCADE,group_id TEXT NOT NULL,group_name VARCHAR(120) NOT NULL,coordinator_environment_id TEXT NOT NULL,coordinator_device_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(owner_account_id,coordinator_device_id,coordinator_environment_id,group_id))`;
          yield* sql`CREATE TABLE IF NOT EXISTS mines_group_invitations(invitation_id TEXT PRIMARY KEY,group_key TEXT NOT NULL REFERENCES mines_contact_groups(group_key) ON DELETE CASCADE,invitee_account_id TEXT NOT NULL REFERENCES mines_contact_profiles(account_id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','left')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
          yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS mines_group_active_invitation ON mines_group_invitations(group_key,invitee_account_id) WHERE status IN ('pending','accepted')`;
          yield* sql`CREATE INDEX IF NOT EXISTS mines_group_invitation_recipient ON mines_group_invitations(invitee_account_id,created_at)`;
          yield* sql`CREATE TABLE IF NOT EXISTS mines_contact_requests(account_id TEXT NOT NULL REFERENCES mines_contact_profiles(account_id) ON DELETE CASCADE,client_request_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('create','invite')),payload TEXT NOT NULL,group_key TEXT NOT NULL REFERENCES mines_contact_groups(group_key) ON DELETE CASCADE,invitation_id TEXT REFERENCES mines_group_invitations(invitation_id) ON DELETE CASCADE,PRIMARY KEY(account_id,client_request_id))`;
        }).pipe(Effect.mapError(storageError)),
        ensureProfile: Effect.fn("ContactsStore.ensureProfile")(function* (accountId, friendId) {
          const existing = yield* readProfile(accountId);
          if (existing) return publicProfile(existing);
          const users = yield* sql<{
            name: string;
            image: string | null;
          }>`SELECT name,image FROM "user" WHERE id=${accountId}`;
          if (!users[0]) return yield* new ContactsError({ code: "forbidden" });
          yield* sql`INSERT INTO mines_contact_profiles(account_id,friend_id,display_name,avatar) VALUES(${accountId},${friendId},${users[0].name.trim().slice(0, 100) || "Mines user"},${initialAvatar(users[0].image)}) ON CONFLICT DO NOTHING`;
          const created = yield* readProfile(accountId);
          if (!created) return yield* new ContactsError({ code: "conflict" });
          return publicProfile(created);
        }, Effect.mapError(storageError)),
        updateProfile: Effect.fn("ContactsStore.updateProfile")((accountId, input) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const current =
                  yield* sql<ProfileRow>`SELECT account_id,friend_id,display_name,avatar,md5(avatar) AS avatar_version FROM mines_contact_profiles WHERE account_id=${accountId} FOR UPDATE`;
                if (!current[0]) return yield* new ContactsError({ code: "not-found" });
                let avatar = input.avatar;
                const avatarUrl = avatar === null ? null : URL.parse(avatar);
                if (
                  avatarUrl?.origin === origin.origin &&
                  avatarUrl.pathname.startsWith("/v1/contacts/avatars/")
                ) {
                  if (
                    !current[0].avatar?.startsWith("data:image/") ||
                    avatarUrl.href !== publicProfile(current[0]).avatar
                  )
                    return yield* new ContactsError({ code: "conflict" });
                  avatar = current[0].avatar;
                }
                const profiles =
                  yield* sql`UPDATE mines_contact_profiles SET display_name=${input.displayName},avatar=${avatar},updated_at=NOW() WHERE account_id=${accountId} RETURNING account_id`;
                if (!profiles.length) return yield* new ContactsError({ code: "not-found" });
                const users =
                  yield* sql`UPDATE "user" SET name=${input.displayName},image=${avatar} WHERE id=${accountId} RETURNING id`;
                if (!users.length) return yield* new ContactsError({ code: "not-found" });
              }),
            )
            .pipe(Effect.mapError(storageError)),
        ),
        findProfile: Effect.fn("ContactsStore.findProfile")((friendId) =>
          sql<ProfileRow>`SELECT account_id,friend_id,display_name,avatar,md5(avatar) AS avatar_version FROM mines_contact_profiles WHERE friend_id=${friendId}`.pipe(
            Effect.map((rows) =>
              rows[0] ? { accountId: rows[0].account_id, profile: publicProfile(rows[0]) } : null,
            ),
            Effect.mapError(storageError),
          ),
        ),
        avatar: Effect.fn("ContactsStore.avatar")((friendId, version) =>
          sql<{
            avatar: string;
          }>`SELECT avatar FROM mines_contact_profiles WHERE friend_id=${friendId} AND md5(avatar)=${version} AND avatar LIKE 'data:image/%'`.pipe(
            Effect.map((rows) => rows[0]?.avatar ?? null),
            Effect.mapError(storageError),
          ),
        ),
        isContact: Effect.fn("ContactsStore.isContact")((accountId, targetAccountId) =>
          sql`SELECT 1 FROM mines_contacts WHERE account_id=${accountId} AND target_account_id=${targetAccountId}`.pipe(
            Effect.map((rows) => rows.length > 0),
            Effect.mapError(storageError),
          ),
        ),
        addContact: Effect.fn("ContactsStore.addContact")((accountId, targetAccountId) =>
          sql`INSERT INTO mines_contacts(account_id,target_account_id) VALUES(${accountId},${targetAccountId}) ON CONFLICT DO NOTHING`.pipe(
            Effect.asVoid,
            Effect.mapError(storageError),
          ),
        ),
        removeContact: Effect.fn("ContactsStore.removeContact")((accountId, targetAccountId) =>
          sql`DELETE FROM mines_contacts WHERE account_id=${accountId} AND target_account_id=${targetAccountId}`.pipe(
            Effect.asVoid,
            Effect.mapError(storageError),
          ),
        ),
        registerGroup: Effect.fn("ContactsStore.registerGroup")((input) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* lockOwner(input);
                const payload = requestPayload(input);
                if (yield* alreadyApplied(input, "create", payload)) return;
                const key = yield* upsertGroup(input);
                yield* sql`INSERT INTO mines_contact_requests(account_id,client_request_id,operation,payload,group_key) VALUES(${input.accountId},${input.clientRequestId},'create',${payload},${key})`;
              }),
            )
            .pipe(Effect.mapError(storageError)),
        ),
        invite: Effect.fn("ContactsStore.invite")((input) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* lockOwner(input);
                const payload = requestPayload(input, input.targetAccountId);
                if (yield* alreadyApplied(input, "invite", payload)) return;
                const contacts =
                  yield* sql`SELECT target_account_id FROM mines_contacts WHERE account_id=${input.accountId} AND target_account_id=${input.targetAccountId} FOR UPDATE`;
                if (!contacts.length) return yield* new ContactsError({ code: "forbidden" });
                const key = yield* upsertGroup(input);
                const active = yield* sql<{
                  invitation_id: string;
                }>`SELECT invitation_id FROM mines_group_invitations WHERE group_key=${key} AND invitee_account_id=${input.targetAccountId} AND status IN ('pending','accepted') FOR UPDATE`;
                const invitationId = active[0]?.invitation_id ?? input.invitationId;
                if (!active[0]) {
                  const counts = yield* sql<{
                    people_count: number;
                  }>`SELECT COUNT(*)::int AS people_count FROM mines_group_invitations WHERE group_key=${key} AND status IN ('pending','accepted')`;
                  if ((counts[0]?.people_count ?? 0) >= CONTACT_GROUP_MAX_PEOPLE - 1)
                    return yield* new ContactsError({ code: "limit" });
                  yield* sql`INSERT INTO mines_group_invitations(invitation_id,group_key,invitee_account_id) VALUES(${invitationId},${key},${input.targetAccountId})`;
                }
                yield* sql`INSERT INTO mines_contact_requests(account_id,client_request_id,operation,payload,group_key,invitation_id) VALUES(${input.accountId},${input.clientRequestId},'invite',${payload},${key},${invitationId})`;
              }),
            )
            .pipe(Effect.mapError(storageError)),
        ),
        transition: Effect.fn("ContactsStore.transition")((accountId, invitationId, action) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const targets = yield* sql<{
                  group_key: string;
                }>`SELECT group_key FROM mines_group_invitations WHERE invitation_id=${invitationId}`;
                if (!targets[0]) return yield* new ContactsError({ code: "not-found" });
                yield* sql`SELECT group_key FROM mines_contact_groups WHERE group_key=${targets[0].group_key} FOR UPDATE`;
                const rows = yield* sql<{
                  group_key: string;
                  invitee_account_id: string;
                  owner_account_id: string;
                  status: InvitationStatus;
                }>`SELECT i.group_key,i.invitee_account_id,g.owner_account_id,i.status FROM mines_group_invitations i JOIN mines_contact_groups g ON g.group_key=i.group_key WHERE i.invitation_id=${invitationId} FOR UPDATE OF i`;
                const invitation = rows[0];
                if (!invitation) return yield* new ContactsError({ code: "not-found" });
                const actor =
                  action === "revoke" ? invitation.owner_account_id : invitation.invitee_account_id;
                if (actor !== accountId) return yield* new ContactsError({ code: "forbidden" });
                const next = {
                  accept: "accepted",
                  decline: "declined",
                  revoke: "revoked",
                  leave: "left",
                }[action];
                if (invitation.status === next) return;
                const allowed =
                  action === "revoke"
                    ? invitation.status === "pending" || invitation.status === "accepted"
                    : action === "leave"
                      ? invitation.status === "accepted"
                      : invitation.status === "pending";
                if (!allowed) return yield* new ContactsError({ code: "conflict" });
                yield* sql`UPDATE mines_group_invitations SET status=${next},updated_at=NOW() WHERE invitation_id=${invitationId}`;
                yield* sql`UPDATE mines_contact_groups SET updated_at=NOW() WHERE group_key=${invitation.group_key}`;
              }),
            )
            .pipe(Effect.mapError(storageError)),
        ),
        groupMembers,
        snapshot: Effect.fn("ContactsStore.snapshot")(function* (accountId) {
          const self = yield* readProfile(accountId);
          if (!self) return yield* new ContactsError({ code: "not-found" });
          const contacts =
            yield* sql<ProfileRow>`SELECT p.account_id,p.friend_id,p.display_name,p.avatar,md5(p.avatar) AS avatar_version FROM mines_contacts c JOIN mines_contact_profiles p ON p.account_id=c.target_account_id WHERE c.account_id=${accountId} ORDER BY p.display_name,p.friend_id LIMIT 500`;
          const invitationRows =
            yield* sql<InvitationRow>`SELECT g.group_key,g.group_id,g.group_name,g.owner_account_id,g.coordinator_environment_id,g.coordinator_device_id,g.updated_at,i.invitation_id,i.invitee_account_id,i.status,i.created_at,i.updated_at AS invitation_updated_at FROM mines_group_invitations i JOIN mines_contact_groups g ON g.group_key=i.group_key WHERE g.owner_account_id=${accountId} OR i.invitee_account_id=${accountId} ORDER BY i.created_at DESC,i.invitation_id LIMIT 500`;
          const groupRows = yield* sql<
            GroupRow & { people_count: number }
          >`SELECT g.group_key,g.group_id,g.group_name,g.owner_account_id,g.coordinator_environment_id,g.coordinator_device_id,g.updated_at,1+(SELECT COUNT(*)::int FROM mines_group_invitations i WHERE i.group_key=g.group_key AND i.status IN ('pending','accepted')) AS people_count FROM mines_contact_groups g WHERE g.owner_account_id=${accountId} OR EXISTS(SELECT 1 FROM mines_group_invitations i WHERE i.group_key=g.group_key AND i.invitee_account_id=${accountId} AND i.status='accepted') ORDER BY g.updated_at DESC,g.group_key LIMIT 200`;
          if (groupRows.some((group) => group.people_count > CONTACT_GROUP_MAX_PEOPLE))
            return yield* new ContactsError({ code: "limit" });
          const accountIds = [
            ...new Set([
              accountId,
              ...invitationRows.flatMap((row) => [row.owner_account_id, row.invitee_account_id]),
              ...groupRows.map((row) => row.owner_account_id),
            ]),
          ];
          const members = groupRows.length
            ? yield* sql<{
                group_key: string;
                account_id: string;
                invitation_id: string | null;
              }>`SELECT group_key,owner_account_id AS account_id,NULL::TEXT AS invitation_id FROM mines_contact_groups WHERE group_key IN ${sql.in(groupRows.map((row) => row.group_key))} UNION SELECT group_key,invitee_account_id AS account_id,invitation_id FROM mines_group_invitations WHERE group_key IN ${sql.in(groupRows.map((row) => row.group_key))} AND status='accepted'`
            : [];
          for (const member of members)
            if (!accountIds.includes(member.account_id)) accountIds.push(member.account_id);
          const people =
            yield* sql<ProfileRow>`SELECT account_id,friend_id,display_name,avatar,md5(avatar) AS avatar_version FROM mines_contact_profiles WHERE account_id IN ${sql.in(accountIds)}`;
          const byId = new Map(people.map((row) => [row.account_id, publicProfile(row)]));
          const person = (id: string) => byId.get(id)!;
          const invitations: GroupInvitation[] = invitationRows.map((row) => ({
            id: row.invitation_id,
            groupKey: row.group_key,
            groupId: row.group_id,
            groupName: row.group_name,
            coordinatorEnvironmentId: row.coordinator_environment_id,
            coordinatorDeviceId: row.coordinator_device_id,
            inviter: person(row.owner_account_id),
            invitee: person(row.invitee_account_id),
            status: row.status,
            createdAt: iso(row.created_at),
            updatedAt: iso(row.invitation_updated_at),
          }));
          const groups: SharedContactGroup[] = groupRows.map((row) => ({
            key: row.group_key,
            groupId: row.group_id,
            groupName: row.group_name,
            coordinatorEnvironmentId: row.coordinator_environment_id,
            coordinatorDeviceId: row.coordinator_device_id,
            owner: person(row.owner_account_id),
            members: members
              .filter((member) => member.group_key === row.group_key)
              .map((member) => person(member.account_id)),
            memberships: members
              .filter(
                (member) => member.group_key === row.group_key && member.invitation_id !== null,
              )
              .map((member) => ({
                invitationId: member.invitation_id!,
                friendId: person(member.account_id).friendId,
              })),
          }));
          return {
            profile: publicProfile(self),
            contacts: contacts.map(publicProfile),
            invitations,
            groups,
          };
        }, Effect.mapError(storageError)),
      });
    }),
  );
};
