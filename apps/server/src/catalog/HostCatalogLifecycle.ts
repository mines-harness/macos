import { catalogHostId, type HostCatalogLifecycle } from "@t3tools/client-runtime/catalog";
import type { ApplicationStoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as HostCatalogService from "./HostCatalogService.ts";

function projectCatalogLifecycle(
  event: ApplicationStoredEvent,
  environmentId: string,
): HostCatalogLifecycle | null {
  if ("aggregateKind" in event) {
    return event.type === "project.deleted"
      ? {
          id: catalogHostId("project", environmentId, event.aggregateId),
          sequence: event.sequence,
          state: "deleted",
        }
      : null;
  }
  const state =
    event.event.type === "thread.archived"
      ? "archived"
      : event.event.type === "thread.unarchived"
        ? "active"
        : event.event.type === "thread.deleted"
          ? "deleted"
          : null;
  return state === null
    ? null
    : {
        id: catalogHostId("thread", environmentId, event.event.threadId),
        sequence: event.sequence,
        state,
      };
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const catalog = yield* HostCatalogService.HostCatalogService;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const sql = yield* SqlClient.SqlClient;
    const environmentId = yield* identity.getEnvironmentId;
    const cursorKey = "mines-catalog-lifecycle-cursor-v1";
    const storedCursor = yield* secrets.get(cursorKey);
    const decodedCursor = Option.isSome(storedCursor)
      ? Number(new TextDecoder().decode(storedCursor.value))
      : 0;
    let cursor = Number.isSafeInteger(decodedCursor) && decodedCursor >= 0 ? decodedCursor : 0;
    const checkpoint = Effect.fn("HostCatalogLifecycle.checkpoint")(function* (sequence: number) {
      yield* secrets.set(cursorKey, new TextEncoder().encode(String(sequence)));
      cursor = sequence;
    });
    const apply = Effect.fn("HostCatalogLifecycle.apply")(function* (event: HostCatalogLifecycle) {
      yield* catalog.applyHostLifecycle(event);
      if (event.state === "deleted")
        yield* sql`DELETE FROM mines_run_contexts WHERE catalog_entity_id = ${event.id}`;
    });
    const throughSequence = yield* events.latestApplicationSequence;
    yield* events.readApplicationEvents({ afterSequence: cursor, throughSequence }).pipe(
      Stream.runForEach((event) => {
        const projected = projectCatalogLifecycle(event, environmentId);
        return projected ? apply(projected) : Effect.void;
      }),
    );
    yield* checkpoint(throughSequence);
    yield* Effect.suspend(() =>
      events
        .streamProjectedApplicationEvents({
          afterSequence: cursor,
          filter: (event) => projectCatalogLifecycle(event, environmentId) !== null,
          project: (event) => projectCatalogLifecycle(event, environmentId)!,
        })
        .pipe(
          Stream.runForEach((event) =>
            apply(event).pipe(Effect.andThen(checkpoint(event.sequence))),
          ),
        ),
    ).pipe(Effect.retry(Schedule.spaced("5 seconds")), Effect.forkScoped);
  }),
);
