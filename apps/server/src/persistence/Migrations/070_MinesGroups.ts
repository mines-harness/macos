import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mines_groups (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE mines_group_members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES mines_groups(id), environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`;
  yield* sql`CREATE UNIQUE INDEX mines_group_member_active_thread ON mines_group_members(environment_id, thread_id) WHERE active = 1`;
  yield* sql`CREATE INDEX mines_group_members_group ON mines_group_members(group_id)`;
  yield* sql`CREATE TABLE mines_group_rounds (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES mines_groups(id), status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`;
  yield* sql`CREATE INDEX mines_group_rounds_active ON mines_group_rounds(status, group_id)`;
  yield* sql`CREATE TABLE mines_group_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES mines_groups(id), round_id TEXT NOT NULL, body TEXT NOT NULL)`;
  yield* sql`CREATE INDEX mines_group_messages_group ON mines_group_messages(group_id, sequence)`;
  yield* sql`CREATE TABLE mines_group_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)`;
  yield* sql`CREATE TABLE mines_group_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`;
});
