import { expect, it } from "@effect/vitest";
import { catalogHostId } from "@t3tools/client-runtime/catalog";
import { EnvironmentId, type ApplicationStoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as HostCatalogService from "./HostCatalogService.ts";
import * as HostCatalogLifecycle from "./HostCatalogLifecycle.ts";

it.effect(
  "removes private run context on thread deletion while preserving archived thread context",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const environmentId = EnvironmentId.make("host");
      const archivedEntity = catalogHostId("thread", environmentId, "archived");
      const deletedEntity = catalogHostId("thread", environmentId, "deleted");
      yield* sql`INSERT INTO mines_run_contexts (run_id, catalog_entity_id, account_id, body) VALUES ('archived-run', ${archivedEntity}, 'owner', 'encrypted'), ('deleted-run', ${deletedEntity}, 'owner', 'encrypted')`;
      const events = [
        { sequence: 1, event: { type: "thread.archived", threadId: "archived" } },
        { sequence: 2, event: { type: "thread.deleted", threadId: "deleted" } },
      ] as unknown as ApplicationStoredEvent[];
      const dependencies = Layer.mergeAll(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeed(Option.none()),
          set: () => Effect.void,
        }),
        Layer.mock(HostCatalogService.HostCatalogService)({
          applyHostLifecycle: () => Effect.void,
        }),
        Layer.mock(EventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(2),
          readApplicationEvents: () => Stream.fromIterable(events),
          streamProjectedApplicationEvents: () => Stream.empty,
        }),
      );
      yield* Effect.void.pipe(
        Effect.provide(HostCatalogLifecycle.layer.pipe(Layer.provide(dependencies))),
      );
      expect(yield* sql`SELECT run_id FROM mines_run_contexts`).toEqual([
        { run_id: "archived-run" },
      ]);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
