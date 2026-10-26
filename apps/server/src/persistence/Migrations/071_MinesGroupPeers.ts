import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mines_group_peer_memberships (thread_id TEXT PRIMARY KEY, coordinator_environment_id TEXT NOT NULL, group_id TEXT NOT NULL, member_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE mines_group_peer_deliveries (delivery_id TEXT PRIMARY KEY, coordinator_environment_id TEXT NOT NULL, group_id TEXT NOT NULL, member_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX mines_group_peer_delivery_thread ON mines_group_peer_deliveries(thread_id)`;
  yield* sql`CREATE TABLE mines_group_peer_pending (id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, body TEXT NOT NULL, unless_active_group INTEGER NOT NULL DEFAULT 0)`;
});
