import { expect, it } from "@effect/vitest";
import { GroupId, IsoDateTime, type Group } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as GroupStore from "./GroupStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

it.effect("replays group lifecycle without message payloads after coalesced notifications", () =>
  Effect.gen(function* () {
    const store = yield* GroupStore.GroupStore;
    const changed = yield* store.catalogChanges;
    const at = IsoDateTime.make("2026-10-25T00:00:00.000Z");
    const group: Group = {
      id: GroupId.make("group"),
      name: "Private group",
      workflow: "team",
      leadMemberId: "lead",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };
    yield* store.commit({ groupId: group.id, kind: "group.created", at, group });
    yield* store.commit({
      groupId: group.id,
      kind: "round.completed",
      at,
      messages: [
        {
          id: "message",
          groupId: group.id,
          roundId: "round",
          memberId: "lead",
          kind: "assistant",
          text: "Private conversation content",
          createdAt: at,
          truncated: false,
        },
      ],
    });
    yield* store.commit({
      groupId: group.id,
      kind: "group.archived",
      at,
      group: { ...group, archivedAt: at },
    });
    yield* store.commit({ groupId: group.id, kind: "group.archived", at, group });
    yield* PubSub.take(changed);
    const events = yield* store.catalogEvents(0);
    expect(events).toEqual([
      { groupId: "group", sequence: 1, archived: false },
      { groupId: "group", sequence: 3, archived: true },
      { groupId: "group", sequence: 4, archived: false },
    ]);
    expect(yield* store.catalogEvents(3)).toEqual([events[2]]);
    expect(JSON.stringify(events)).not.toContain("Private");
  }).pipe(
    Effect.provide(GroupStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Effect.scoped,
  ),
);

it.effect("excludes shared group lifecycle and membership from the private catalog", () =>
  Effect.gen(function* () {
    const store = yield* GroupStore.GroupStore;
    const at = IsoDateTime.make("2026-10-25T00:00:00.000Z");
    const group: Group = {
      id: GroupId.make("shared"),
      visibility: "shared",
      name: "Friends",
      workflow: "team",
      leadMemberId: "",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    };
    yield* store.commit({ groupId: group.id, kind: "group.created", at, group });
    yield* store.commit({ groupId: group.id, kind: "group.members-added", at });
    yield* store.commit({
      groupId: group.id,
      kind: "group.archived",
      at,
      group: { ...group, archivedAt: at },
    });
    expect(yield* store.catalogEvents(0)).toEqual([]);
    expect((yield* store.list()).map((entry) => entry.id)).toEqual([group.id]);
  }).pipe(Effect.provide(GroupStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);
