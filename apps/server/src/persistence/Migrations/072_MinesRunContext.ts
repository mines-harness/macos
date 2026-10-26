import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE mines_run_contexts (run_id TEXT PRIMARY KEY, catalog_entity_id TEXT NOT NULL, account_id TEXT NOT NULL, body TEXT NOT NULL)`;
  yield* sql`CREATE INDEX mines_run_context_entity ON mines_run_contexts(catalog_entity_id)`;
});
