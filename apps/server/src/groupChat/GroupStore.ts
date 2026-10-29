import {
  ChatAttachment,
  EnvironmentId,
  Group,
  GroupChatError,
  GroupId,
  GroupMember,
  GroupMessage,
  GroupRound,
  ThreadId,
  type GroupMembershipRef,
  type GroupSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

interface Commit {
  readonly groupId: GroupId;
  readonly kind: string;
  readonly at: string;
  readonly group?: Group;
  readonly members?: ReadonlyArray<GroupMember>;
  readonly removedMemberIds?: ReadonlyArray<string>;
  readonly round?: GroupRound;
  readonly messages?: ReadonlyArray<GroupMessage>;
  readonly receipt?: { readonly id: string; readonly fingerprint: string; readonly result: string };
  readonly membershipActive?: boolean;
}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeGroup = Schema.decodeUnknownSync(Schema.fromJsonString(Group));
const decodeMember = Schema.decodeUnknownSync(Schema.fromJsonString(GroupMember));
const decodeRound = Schema.decodeUnknownSync(Schema.fromJsonString(GroupRound));
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(GroupMessage));
const decodeAttachment = Schema.decodeEffect(Schema.fromJsonString(ChatAttachment));
const storageError = () =>
  new GroupChatError({ code: "storage", message: "Group history could not be read or saved." });

export class GroupStore extends Context.Service<
  GroupStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Group>, GroupChatError>;
    readonly listMemberships: () => Effect.Effect<
      ReadonlyArray<GroupMembershipRef>,
      GroupChatError
    >;
    readonly message: (
      groupId: GroupId,
      messageId: string,
    ) => Effect.Effect<GroupMessage | undefined, GroupChatError>;
    readonly deliveryRound: (
      groupId: GroupId,
      deliveryId: string,
    ) => Effect.Effect<GroupRound, GroupChatError>;
    readonly attachment: (
      groupId: GroupId,
      attachmentId: string,
    ) => Effect.Effect<ChatAttachment | undefined, GroupChatError>;
    readonly get: (
      groupId: GroupId,
      beforeMessageId?: string,
    ) => Effect.Effect<GroupSnapshot, GroupChatError>;
    readonly activeRounds: () => Effect.Effect<ReadonlyArray<GroupRound>, GroupChatError>;
    readonly round: (roundId: string) => Effect.Effect<GroupRound, GroupChatError>;
    readonly messagesThrough: (
      groupId: GroupId,
      messageId: string | null,
    ) => Effect.Effect<ReadonlyArray<GroupMessage>, GroupChatError>;
    readonly membership: (
      threadId: string,
      environmentId?: string | null,
    ) => Effect.Effect<GroupMember | undefined, GroupChatError>;
    readonly receipt: (
      id: string,
    ) => Effect.Effect<
      { readonly fingerprint: string; readonly result: string } | undefined,
      GroupChatError
    >;
    readonly commit: (input: Commit) => Effect.Effect<void, GroupChatError>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<GroupId>, never, Scope.Scope>;
    readonly notify: (groupId: GroupId) => Effect.Effect<boolean>;
    readonly catalogChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly catalogEvents: (afterSequence: number) => Effect.Effect<
      ReadonlyArray<{
        readonly groupId: string;
        readonly sequence: number;
        readonly archived: boolean;
      }>,
      GroupChatError
    >;
  }
>()("mines/groupChat/GroupStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<GroupId>(64);
  const catalogChanges = yield* PubSub.sliding<void>(1);
  const catalogEvents = Effect.fn("GroupStore.catalogEvents")(function* (afterSequence: number) {
    const rows = yield* sql<{ group_id: string; sequence: number; archived_at: string | null }>`
      SELECT e.group_id, e.sequence, json_extract(e.body, '$.group.archivedAt') AS archived_at
      FROM mines_group_events e JOIN mines_groups g ON g.id = e.group_id
      WHERE e.sequence > ${afterSequence} AND e.kind IN ('group.created', 'group.archived', 'group.members-added', 'group.members-removed')
        AND COALESCE(json_extract(g.body, '$.visibility'), 'private') <> 'shared'
        AND COALESCE(json_extract(e.body, '$.group.visibility'), 'private') <> 'shared'
      ORDER BY e.sequence LIMIT 500
    `;
    return rows.map((row) => ({
      groupId: row.group_id,
      sequence: row.sequence,
      archived: row.archived_at !== null,
    }));
  }, Effect.mapError(storageError));
  const list = Effect.fn("GroupStore.list")(function* () {
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_groups ORDER BY updated_at DESC LIMIT 200`;
    return rows.map((row) => decodeGroup(row.body));
  }, Effect.mapError(storageError));
  const listMemberships = Effect.fn("GroupStore.listMemberships")(function* () {
    const rows = yield* sql<{
      group_id: string;
      thread_id: string;
      environment_id: string;
    }>`SELECT group_id, thread_id, environment_id FROM mines_group_members
       WHERE active = 1 AND group_id IN
         (SELECT id FROM mines_groups WHERE COALESCE(json_extract(body, '$.visibility'), 'private') <> 'shared' ORDER BY updated_at DESC LIMIT 200)
       ORDER BY rowid`;
    return rows.map((row) => ({
      groupId: GroupId.make(row.group_id),
      threadId: ThreadId.make(row.thread_id),
      environmentId: row.environment_id === "local" ? null : EnvironmentId.make(row.environment_id),
    }));
  }, Effect.mapError(storageError));
  const messagesThrough = Effect.fn("GroupStore.messagesThrough")(function* (
    groupId: GroupId,
    messageId: string | null,
  ) {
    const rows =
      messageId === null
        ? yield* sql<{
            body: string;
          }>`SELECT body FROM mines_group_messages WHERE group_id = ${groupId} ORDER BY sequence DESC LIMIT 80`
        : yield* sql<{
            body: string;
          }>`SELECT body FROM mines_group_messages WHERE group_id = ${groupId} AND sequence <= (SELECT sequence FROM mines_group_messages WHERE id = ${messageId}) ORDER BY sequence DESC LIMIT 80`;
    return rows.map((row) => decodeMessage(row.body)).reverse();
  }, Effect.mapError(storageError));
  const get = Effect.fn("GroupStore.get")(function* (groupId: GroupId, beforeMessageId?: string) {
    const groups = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_groups WHERE id = ${groupId}`.pipe(Effect.mapError(storageError));
    if (!groups[0])
      return yield* new GroupChatError({
        code: "not-found",
        message: "This group no longer exists.",
      });
    const members = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_group_members WHERE group_id = ${groupId} ORDER BY rowid`.pipe(
      Effect.mapError(storageError),
    );
    const rounds = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_group_rounds WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT 12`.pipe(
      Effect.mapError(storageError),
    );
    const recent =
      beforeMessageId === undefined
        ? yield* messagesThrough(groupId, null)
        : (yield* sql<{
            body: string;
          }>`SELECT body FROM mines_group_messages WHERE group_id = ${groupId} AND sequence < (SELECT sequence FROM mines_group_messages WHERE group_id = ${groupId} AND id = ${beforeMessageId}) ORDER BY sequence DESC LIMIT 40`.pipe(
            Effect.mapError(storageError),
          ))
            .map((row) => decodeMessage(row.body))
            .reverse();
    let budget = 128_000;
    const selected: GroupMessage[] = [];
    for (const message of recent.toReversed()) {
      if (budget <= 0) break;
      const text = message.text.slice(0, Math.min(32_000, budget));
      const { context, ...withoutContext } = message;
      const contextBytes = context === undefined ? 0 : Buffer.byteLength(encodeJson(context));
      const metadata = {
        ...withoutContext,
        ...(message.attachments
          ? {
              attachments: message.attachments.map((attachment) =>
                "source" in attachment
                  ? (({ source: _source, ...rest }) => rest)(attachment)
                  : attachment,
              ),
            }
          : {}),
        text: "",
      };
      const metadataBytes = Buffer.byteLength(encodeJson(metadata));
      if (metadataBytes > budget && selected.length > 0) break;
      const deferred =
        context !== undefined &&
        (contextBytes > 32 * 1024 || contextBytes + metadataBytes + text.length > budget);
      selected.unshift({
        ...metadata,
        ...(deferred ? { contextDeferred: true } : context ? { context } : {}),
        text,
        truncated: message.truncated || text.length < message.text.length,
      });
      budget -= Buffer.byteLength(text) + metadataBytes + (deferred ? 0 : contextBytes);
    }
    const referencedIds = [
      ...new Set(
        selected.flatMap((message) => (message.roundId === null ? [] : [message.roundId])),
      ),
    ];
    const referenced = referencedIds.length
      ? yield* sql<{
          body: string;
        }>`SELECT body FROM mines_group_rounds WHERE group_id = ${groupId} AND id IN ${sql.in(referencedIds)}`.pipe(
          Effect.mapError(storageError),
        )
      : [];
    const roundRows =
      beforeMessageId === undefined
        ? [
            ...rounds,
            ...referenced.filter((row) => !rounds.some((current) => current.body === row.body)),
          ]
        : referenced;
    const oldest = selected[0];
    const more = oldest
      ? yield* sql`SELECT 1 FROM mines_group_messages WHERE group_id = ${groupId} AND sequence < (SELECT sequence FROM mines_group_messages WHERE group_id = ${groupId} AND id = ${oldest.id}) LIMIT 1`.pipe(
          Effect.mapError(storageError),
        )
      : [];
    return {
      group: decodeGroup(groups[0].body),
      members: members.map((row) => decodeMember(row.body)),
      rounds: roundRows
        .map((row) => decodeRound(row.body))
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((round) => ({
          ...round,
          deliveries: round.deliveries.map((delivery) => ({
            ...delivery,
            request: delivery.request.slice(0, 500),
          })),
        }))
        .reverse(),
      messages: selected,
      hasMoreMessages: more.length > 0,
    } satisfies GroupSnapshot;
  });
  const round = Effect.fn("GroupStore.round")(function* (roundId: string) {
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_group_rounds WHERE id = ${roundId}`.pipe(
      Effect.mapError(storageError),
    );
    if (!rows[0])
      return yield* new GroupChatError({
        code: "not-found",
        message: "This group round no longer exists.",
      });
    return decodeRound(rows[0].body);
  });
  const activeRounds = Effect.fn("GroupStore.activeRounds")(function* () {
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_group_rounds WHERE status = 'active' ORDER BY created_at`;
    return rows.map((row) => decodeRound(row.body));
  }, Effect.mapError(storageError));
  const membership = Effect.fn("GroupStore.membership")(function* (
    threadId: string,
    environmentId?: string | null,
  ) {
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM mines_group_members WHERE thread_id = ${threadId} AND environment_id = ${environmentId ?? "local"} AND active = 1`;
    return rows[0] ? decodeMember(rows[0].body) : undefined;
  }, Effect.mapError(storageError));
  const receipt = Effect.fn("GroupStore.receipt")(function* (id: string) {
    const rows = yield* sql<{
      fingerprint: string;
      result: string;
    }>`SELECT fingerprint, result FROM mines_group_receipts WHERE id = ${id}`;
    return rows[0];
  }, Effect.mapError(storageError));
  const commit = Effect.fn("GroupStore.commit")(function* (input: Commit) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (input.group)
          yield* sql`INSERT INTO mines_groups (id, body, updated_at) VALUES (${input.group.id}, ${encodeJson(input.group)}, ${input.at}) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`;
        if (input.removedMemberIds?.length)
          yield* sql`DELETE FROM mines_group_members WHERE group_id = ${input.groupId} AND id IN ${sql.in(input.removedMemberIds)}`;
        if (input.members)
          for (const member of input.members) {
            yield* sql`INSERT INTO mines_group_members (id, group_id, environment_id, thread_id, body, active) VALUES (${member.id}, ${member.groupId}, ${member.environmentId ?? "local"}, ${member.threadId}, ${encodeJson(member)}, 1)`;
          }
        if (input.membershipActive !== undefined)
          yield* sql`UPDATE mines_group_members SET active = ${input.membershipActive ? 1 : 0} WHERE group_id = ${input.groupId}`;
        if (input.round)
          yield* sql`INSERT INTO mines_group_rounds (id, group_id, status, body, created_at) VALUES (${input.round.id}, ${input.groupId}, ${input.round.status}, ${encodeJson(input.round)}, ${input.round.createdAt}) ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body`;
        if (input.messages)
          for (const message of input.messages) {
            yield* sql`INSERT INTO mines_group_messages (id, group_id, round_id, body) VALUES (${message.id}, ${input.groupId}, ${message.roundId ?? ""}, ${encodeJson(message)}) ON CONFLICT(id) DO UPDATE SET body = excluded.body`;
          }
        if (input.receipt)
          yield* sql`INSERT INTO mines_group_receipts (id, fingerprint, result) VALUES (${input.receipt.id}, ${input.receipt.fingerprint}, ${input.receipt.result})`;
        yield* sql`INSERT INTO mines_group_events (group_id, kind, body, created_at) VALUES (${input.groupId}, ${input.kind}, ${encodeJson(input)}, ${input.at})`;
      }),
    );
    yield* PubSub.publish(changes, input.groupId);
    if (
      input.group?.visibility !== "shared" &&
      (input.kind === "group.created" ||
        input.kind === "group.archived" ||
        input.kind === "group.members-added" ||
        input.kind === "group.members-removed")
    )
      yield* PubSub.publish(catalogChanges, undefined);
  }, Effect.mapError(storageError));
  return GroupStore.of({
    list,
    listMemberships,
    get,
    message: Effect.fn("GroupStore.message")(function* (groupId, messageId) {
      const rows = yield* sql<{
        body: string;
      }>`SELECT body FROM mines_group_messages WHERE group_id = ${groupId} AND id = ${messageId}`.pipe(
        Effect.mapError(storageError),
      );
      return rows[0] ? decodeMessage(rows[0].body) : undefined;
    }),
    deliveryRound: Effect.fn("GroupStore.deliveryRound")(function* (groupId, deliveryId) {
      const rows = yield* sql<{
        body: string;
      }>`SELECT r.body FROM mines_group_rounds r, json_each(json_extract(r.body, '$.deliveries')) d WHERE r.group_id = ${groupId} AND json_extract(d.value, '$.id') = ${deliveryId} LIMIT 1`.pipe(
        Effect.mapError(storageError),
      );
      if (!rows[0])
        return yield* new GroupChatError({
          code: "not-found",
          message: "This delivery is not part of the group.",
        });
      return decodeRound(rows[0].body);
    }),
    attachment: Effect.fn("GroupStore.attachment")(function* (groupId, attachmentId) {
      const rows = yield* sql<{
        value: string;
      }>`SELECT a.value FROM mines_group_messages m, json_each(json_extract(m.body, '$.attachments')) a WHERE m.group_id = ${groupId} AND json_extract(a.value, '$.id') = ${attachmentId} LIMIT 1`;
      return rows[0] ? yield* decodeAttachment(rows[0].value) : undefined;
    }, Effect.mapError(storageError)),
    round,
    activeRounds,
    messagesThrough,
    membership,
    receipt,
    commit,
    subscribe: PubSub.subscribe(changes),
    notify: Effect.fn("GroupStore.notify")((groupId) => PubSub.publish(changes, groupId)),
    catalogChanges: PubSub.subscribe(catalogChanges),
    catalogEvents,
  });
});

export const layer = Layer.effect(GroupStore, make);
