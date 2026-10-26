import { catalogHostId } from "@t3tools/client-runtime/catalog";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GroupStore from "../groupChat/GroupStore.ts";
import * as HostCatalogService from "./HostCatalogService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const groups = yield* GroupStore.GroupStore;
    const catalog = yield* HostCatalogService.HostCatalogService;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environmentId = yield* identity.getEnvironmentId;
    const changes = yield* groups.catalogChanges;
    const cursorKey = "mines-group-catalog-cursor-v1";
    const stored = yield* secrets.get(cursorKey);
    const decoded = Option.isSome(stored) ? Number(new TextDecoder().decode(stored.value)) : 0;
    let cursor = Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : 0;
    const drain = Effect.fn("HostGroupCatalogLifecycle.drain")(function* () {
      let page = yield* groups.catalogEvents(cursor);
      while (page.length > 0) {
        for (const event of page) {
          yield* catalog.applyHostLifecycle({
            id: catalogHostId("group", environmentId, event.groupId),
            sequence: event.sequence,
            state: event.archived ? "archived" : "active",
          });
        }
        const next = page.at(-1)!.sequence;
        yield* secrets.set(cursorKey, new TextEncoder().encode(String(next)));
        cursor = next;
        page = yield* groups.catalogEvents(cursor);
      }
    });
    yield* drain();
    yield* Effect.forever(drain().pipe(Effect.andThen(PubSub.take(changes)))).pipe(
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
  }),
);
