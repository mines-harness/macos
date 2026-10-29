import { describe, expect, it } from "vite-plus/test";
import {
  MinesCatalog,
  catalogHostId,
  type MinesCatalogEntry,
  type MinesCatalogSnapshot,
} from "@t3tools/client-runtime/catalog";
import { buildLibraryRows } from "./MinesLibrary.logic";

it("shows pinned sections, projects, and mines only in their pinned placements", () => {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "section", kind: "section", title: "Work" });
  catalog.upsert({ id: "project", kind: "project", title: "App" }, { parentId: "section" });
  catalog.upsert({ id: "mine", kind: "thread", title: "Build" }, { parentId: "project" });
  const originalRoots = catalog.getSnapshot().roots;
  catalog.pin("section");
  catalog.pin("project");
  catalog.pin("mine");
  const rows = buildLibraryRows(
    catalog.getSnapshot(),
    new Set(),
    new Set(["pins/project", "pins/section/project", "library/section/project"]),
    new Set(),
  ).filter((row) => "entry" in row);
  expect(rows.map((row) => row.key)).toEqual(["pins/section", "pins/project", "pins/mine"]);
  expect(rows.every((row) => !row.hasChildren)).toBe(true);
  expect(catalog.getSnapshot().roots).toEqual(originalRoots);

  catalog.unpin("project");
  const unpinned = buildLibraryRows(
    catalog.getSnapshot(),
    new Set(),
    new Set(["pins/section/project"]),
    new Set(),
  ).filter((row) => "entry" in row);
  expect(unpinned.map((row) => row.key)).toEqual([
    "pins/section",
    "pins/section/project",
    "pins/mine",
  ]);
  expect(catalog.getSnapshot().roots).toEqual(originalRoots);
});

describe("library row identity", () => {
  it("keeps pinned containers and descendants in one visible placement each", () => {
    let id = 0;
    const catalog = new MinesCatalog({ createId: () => `placement-${++id}` });
    catalog.upsert({ id: "section", kind: "section", title: "Work" });
    catalog.upsert({ id: "project", kind: "project", title: "App" }, { parentId: "section" });
    catalog.upsert({ id: "thread", kind: "thread", title: "Build" }, { parentId: "project" });
    catalog.pin("section");
    catalog.pin("project");
    const rows = buildLibraryRows(
      catalog.getSnapshot(),
      new Set(),
      new Set(["pins/section/project", "pins/project", "library/section/project"]),
      new Set(),
    );
    const entries = rows.filter((row) => "entry" in row);
    expect(entries.filter((row) => row.entry.entity.id === "thread")).toHaveLength(1);
    expect(new Set(entries.map((row) => row.key)).size).toBe(entries.length);
    expect(entries.filter((row) => row.pinned).map((row) => row.entry.entity.id)).toEqual([
      "section",
      "project",
    ]);
  });

  it("keeps an unpinned container and its other children when a nested mine is pinned", () => {
    const catalog = new MinesCatalog();
    catalog.upsert({ id: "section", kind: "section", title: "Work" });
    catalog.upsert({ id: "project", kind: "project", title: "App" }, { parentId: "section" });
    catalog.upsert({ id: "mine", kind: "thread", title: "Build" }, { parentId: "project" });
    catalog.upsert({ id: "other", kind: "thread", title: "Review" }, { parentId: "project" });
    catalog.pin("mine");
    const listed = () =>
      buildLibraryRows(
        catalog.getSnapshot(),
        new Set(),
        new Set(["library/section/project"]),
        new Set(),
      ).filter((row) => "entry" in row);
    const pinned = listed();
    expect(pinned.map((row) => row.key)).toEqual([
      "pins/mine",
      "library/section",
      "library/section/project",
      "library/section/project/other",
    ]);
    expect(pinned.at(-1)?.siblings.map((entry) => entry.entity.id)).toEqual(["other"]);
    expect(pinned.at(-1)?.index).toBe(0);
    catalog.unpin("mine");
    expect(listed().map((row) => row.key)).toEqual([
      "library/section",
      "library/section/project",
      "library/section/project/mine",
      "library/section/project/other",
    ]);
  });
});

function nestedThreadSnapshot(): MinesCatalogSnapshot {
  const child: MinesCatalogEntry = {
    entity: { id: "child", kind: "thread", title: "Research" },
    children: [
      {
        entity: { id: "grandchild", kind: "thread", title: "Check sources" },
        children: [],
        parentId: "child",
        orphaned: false,
      },
    ],
    parentId: "parent",
    orphaned: false,
  };
  const parent: MinesCatalogEntry = {
    entity: { id: "parent", kind: "thread", title: "Build" },
    children: [child],
    parentId: null,
    orphaned: false,
  };
  return {
    version: 1,
    roots: [parent],
    pins: [parent],
    entities: [parent.entity, child.entity, child.children[0]!.entity],
  };
}

describe("thread hierarchy", () => {
  it("keeps child families closed until their parent is expanded", () => {
    const rows = buildLibraryRows(nestedThreadSnapshot(), new Set(), new Set(), new Set());
    expect(rows.filter((row) => "entry" in row).map((row) => [row.key, row.open])).toEqual([
      ["pins/parent", false],
    ]);
  });

  it("expands nested threads only in their pinned family", () => {
    const rows = buildLibraryRows(
      nestedThreadSnapshot(),
      new Set(),
      new Set(["pins/parent", "pins/parent/child", "library/parent", "library/parent/child"]),
      new Set(),
    );
    const entries = rows.filter((row) => "entry" in row);
    expect(entries.map((row) => [row.key, row.depth])).toEqual([
      ["pins/parent", 0],
      ["pins/parent/child", 1],
      ["pins/parent/child/grandchild", 2],
    ]);
  });

  it("filters hidden descendants inside an expanded pinned family", () => {
    const rows = buildLibraryRows(
      nestedThreadSnapshot(),
      new Set(),
      new Set(["pins/parent", "pins/parent/child"]),
      new Set(["grandchild"]),
    );
    const entries = rows.filter((row) => "entry" in row);
    expect(entries.map((row) => row.key)).toEqual(["pins/parent", "pins/parent/child"]);
    expect(entries.find((row) => row.key === "pins/parent")?.open).toBe(true);
    expect(entries.find((row) => row.key === "pins/parent/child")?.hasChildren).toBe(false);
  });

  it("lists subagents only under mines or as pinned aliases, keeping forks and other environments", () => {
    let id = 0;
    const catalog = new MinesCatalog({ createId: () => `placement-${++id}` });
    const childId = catalogHostId("thread", "device-a", "child");
    const otherChildId = catalogHostId("thread", "device-b", "child");
    catalog.upsert({ id: "parent", kind: "thread", title: "Build" });
    catalog.upsert({ id: "project", kind: "project", title: "App" });
    catalog.upsert({ id: childId, kind: "thread", title: "Agent" }, { parentId: "project" });
    catalog.upsert({ id: otherChildId, kind: "thread", title: "Fork" });
    catalog.pin(childId);
    const listed = () =>
      buildLibraryRows(
        catalog.getSnapshot(),
        new Set(),
        new Set(["library/project", "library/parent"]),
        new Set(),
        new Set([childId]),
      ).filter((row) => "entry" in row);

    expect(listed().map((row) => row.entry.entity.id)).toEqual([
      childId,
      "parent",
      "project",
      otherChildId,
    ]);
    expect(listed().find((row) => row.entry.entity.id === "project")?.hasChildren).toBe(false);
    catalog.move(childId, null);
    expect(listed().filter((row) => row.entry.entity.id === childId)).toHaveLength(1);
    catalog.move(childId, "parent");
    expect(
      listed()
        .filter((row) => row.entry.entity.id === childId)
        .map((row) => [row.pinned, row.depth]),
    ).toEqual([[true, 0]]);
  });

  it("hides archived children in both pinned and nested placements", () => {
    const snapshot = nestedThreadSnapshot();
    const rows = buildLibraryRows(
      { ...snapshot, pins: [snapshot.roots[0]!.children[0]!] },
      new Set(),
      new Set(["library/parent"]),
      new Set(["child"]),
      new Set(["child", "grandchild"]),
    );
    const entries = rows.filter((row) => "entry" in row);
    expect(entries.map((row) => row.entry.entity.id)).toEqual(["parent"]);
    expect(entries[0]?.hasChildren).toBe(false);
  });
});
