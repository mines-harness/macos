import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MinesCatalogEntry, MinesCatalogSnapshot } from "@t3tools/contracts/minesCatalog";
import * as DateTime from "effect/DateTime";
import { historyPrefetchCandidates, type HistoryPrefetchThread } from "./historyPrefetch.ts";

const environmentId = EnvironmentId.make("host");
const thread = (id: string, time: number): HistoryPrefetchThread => ({
  environmentId,
  thread: {
    id: ThreadId.make(id),
    status: "idle",
    updatedAt: DateTime.makeUnsafe(time),
    archivedAt: null,
    deletedAt: null,
  },
});
const pin = (id: string): MinesCatalogEntry => ({
  entity: { id, kind: "thread", title: id, hostRef: { environmentId, entityId: id } },
  children: [],
  parentId: null,
  orphaned: false,
});
const catalog = (pins: readonly MinesCatalogEntry[]): MinesCatalogSnapshot => ({
  version: 1,
  pins,
  roots: [],
  entities: [],
});

describe("passive history prefetch ordering", () => {
  it("warms pinned containers and threads first, then recent, without duplicate requests", () => {
    const parent: MinesCatalogEntry = {
      entity: { id: "project", title: "Project", kind: "project" },
      children: [pin("older")],
      parentId: null,
      orphaned: false,
    };
    const candidates = historyPrefetchCandidates(
      catalog([parent, pin("older"), pin("unavailable")]),
      [thread("middle", 2), thread("older", 1), thread("newest", 3)],
    );
    expect(candidates.map((candidate) => candidate.input.threadId)).toEqual([
      "older",
      "newest",
      "middle",
    ]);
  });

  it("pauses all background warming for running members and excludes deleted or archived threads", () => {
    const active = thread("active", 4);
    active.thread = { ...active.thread, status: "running" };
    expect(historyPrefetchCandidates(catalog([]), [thread("idle", 1), active])).toEqual([]);
    const archived = thread("archived", 3);
    archived.thread = { ...archived.thread, archivedAt: DateTime.makeUnsafe(1) };
    expect(
      historyPrefetchCandidates(catalog([pin("archived")]), [archived, thread("idle", 1)]).map(
        (candidate) => candidate.input.threadId,
      ),
    ).toEqual(["idle"]);
  });
});
