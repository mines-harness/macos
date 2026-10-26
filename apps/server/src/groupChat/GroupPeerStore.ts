import {
  EnvironmentId,
  GroupChatError,
  GroupId,
  GroupPeerRequest,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface Membership {
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly groupId: GroupId;
  readonly memberId: string;
  readonly threadId: ThreadId;
}
export interface Delivery extends Membership {
  readonly deliveryId: string;
  readonly runId: RunId | null;
  readonly cancelled: boolean;
}
export interface Pending {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly request: GroupPeerRequest;
  readonly unlessActiveGroup: boolean;
}
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(GroupPeerRequest));
const decodeRequest = Schema.decodeSync(Schema.fromJsonString(GroupPeerRequest));
type MembershipRow = {
  coordinator_environment_id: string;
  group_id: string;
  member_id: string;
  thread_id: string;
};
type DeliveryRow = MembershipRow & {
  delivery_id: string;
  run_id: string | null;
  cancelled: number;
};
const membershipFromRow = (row: MembershipRow): Membership => ({
  coordinatorEnvironmentId: EnvironmentId.make(row.coordinator_environment_id),
  groupId: GroupId.make(row.group_id),
  memberId: row.member_id,
  threadId: ThreadId.make(row.thread_id),
});
const deliveryFromRow = (row: DeliveryRow): Delivery => ({
  ...membershipFromRow(row),
  deliveryId: row.delivery_id,
  runId: row.run_id === null ? null : RunId.make(row.run_id),
  cancelled: row.cancelled === 1,
});
const storageError = () =>
  new GroupChatError({ code: "storage", message: "Remote group membership could not be saved." });
const isGroupChatError = Schema.is(GroupChatError);
export const sameMembership = (left: Membership, right: Membership) =>
  left.coordinatorEnvironmentId === right.coordinatorEnvironmentId &&
  left.groupId === right.groupId &&
  left.memberId === right.memberId &&
  left.threadId === right.threadId;

export class GroupPeerStore extends Context.Service<
  GroupPeerStore,
  {
    readonly membership: (
      threadId: ThreadId,
    ) => Effect.Effect<Membership | undefined, GroupChatError>;
    readonly reserve: (input: Membership) => Effect.Effect<void, GroupChatError>;
    readonly release: (input: Membership) => Effect.Effect<void, GroupChatError>;
    readonly delivery: (deliveryId: string) => Effect.Effect<Delivery | undefined, GroupChatError>;
    readonly deliveries: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<Delivery>, GroupChatError>;
    readonly start: (
      input: Membership & { readonly deliveryId: string },
    ) => Effect.Effect<Delivery, GroupChatError>;
    readonly dispatched: (deliveryId: string, runId: RunId) => Effect.Effect<void, GroupChatError>;
    readonly cancel: (deliveryId: string) => Effect.Effect<void, GroupChatError>;
    readonly defer: (input: Pending) => Effect.Effect<void, GroupChatError>;
    readonly pending: Effect.Effect<ReadonlyArray<Pending>, GroupChatError>;
    readonly acknowledge: (id: string) => Effect.Effect<void, GroupChatError>;
  }
>()("mines/groupChat/GroupPeerStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const membership = Effect.fn("GroupPeerStore.membership")(function* (threadId: ThreadId) {
    const rows =
      yield* sql<MembershipRow>`SELECT * FROM mines_group_peer_memberships WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(storageError),
      );
    return rows[0] ? membershipFromRow(rows[0]) : undefined;
  });
  const reserve = Effect.fn("GroupPeerStore.reserve")(function* (input: Membership) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const local =
            yield* sql`SELECT id FROM mines_group_members WHERE environment_id = 'local' AND thread_id = ${input.threadId} AND active = 1`.pipe(
              Effect.mapError(storageError),
            );
          const previous = yield* membership(input.threadId);
          if (local.length > 0 || (previous && !sameMembership(previous, input)))
            return yield* new GroupChatError({
              code: "already-grouped",
              message: "This original mine already belongs to another active group.",
            });
          yield* sql`INSERT INTO mines_group_peer_memberships (thread_id, coordinator_environment_id, group_id, member_id) VALUES (${input.threadId}, ${input.coordinatorEnvironmentId}, ${input.groupId}, ${input.memberId}) ON CONFLICT(thread_id) DO NOTHING`.pipe(
            Effect.mapError(storageError),
          );
        }),
      )
      .pipe(Effect.mapError((error) => (isGroupChatError(error) ? error : storageError())));
  });
  const release = Effect.fn("GroupPeerStore.release")(function* (input: Membership) {
    yield* sql`DELETE FROM mines_group_peer_memberships WHERE thread_id = ${input.threadId} AND coordinator_environment_id = ${input.coordinatorEnvironmentId} AND group_id = ${input.groupId} AND member_id = ${input.memberId}`.pipe(
      Effect.mapError(storageError),
    );
  });
  const delivery = Effect.fn("GroupPeerStore.delivery")(function* (deliveryId: string) {
    const rows =
      yield* sql<DeliveryRow>`SELECT * FROM mines_group_peer_deliveries WHERE delivery_id = ${deliveryId}`.pipe(
        Effect.mapError(storageError),
      );
    return rows[0] ? deliveryFromRow(rows[0]) : undefined;
  });
  const start = Effect.fn("GroupPeerStore.start")(function* (
    input: Membership & { readonly deliveryId: string },
  ) {
    const previous = yield* delivery(input.deliveryId);
    if (previous) {
      if (!sameMembership(previous, input))
        return yield* new GroupChatError({
          code: "invalid-members",
          message: "This delivery belongs to another remote group.",
        });
      return previous;
    }
    yield* sql`INSERT INTO mines_group_peer_deliveries (delivery_id, coordinator_environment_id, group_id, member_id, thread_id) VALUES (${input.deliveryId}, ${input.coordinatorEnvironmentId}, ${input.groupId}, ${input.memberId}, ${input.threadId})`.pipe(
      Effect.mapError(storageError),
    );
    return { ...input, runId: null, cancelled: false };
  });
  return GroupPeerStore.of({
    membership,
    reserve,
    release,
    delivery,
    deliveries: (threadId) =>
      sql<DeliveryRow>`SELECT * FROM mines_group_peer_deliveries WHERE thread_id = ${threadId} ORDER BY rowid DESC LIMIT 24`.pipe(
        Effect.map((rows) => rows.map(deliveryFromRow)),
        Effect.mapError(storageError),
      ),
    start,
    dispatched: (deliveryId, runId) =>
      sql`UPDATE mines_group_peer_deliveries SET run_id = ${runId} WHERE delivery_id = ${deliveryId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    cancel: (deliveryId) =>
      sql`UPDATE mines_group_peer_deliveries SET cancelled = 1 WHERE delivery_id = ${deliveryId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    defer: (input) =>
      sql`INSERT INTO mines_group_peer_pending (id, environment_id, body, unless_active_group) VALUES (${input.id}, ${input.environmentId}, ${encodeRequest(input.request)}, ${input.unlessActiveGroup ? 1 : 0}) ON CONFLICT(id) DO NOTHING`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    pending: sql<{
      id: string;
      environment_id: string;
      body: string;
      unless_active_group: number;
    }>`SELECT * FROM mines_group_peer_pending ORDER BY rowid`.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: row.id,
          environmentId: EnvironmentId.make(row.environment_id),
          request: decodeRequest(row.body),
          unlessActiveGroup: row.unless_active_group === 1,
        })),
      ),
      Effect.mapError(storageError),
    ),
    acknowledge: (id) =>
      sql`DELETE FROM mines_group_peer_pending WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
  });
});

export const layer = Layer.effect(GroupPeerStore, make);
