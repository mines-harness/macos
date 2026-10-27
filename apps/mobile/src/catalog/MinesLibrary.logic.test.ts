import { describe, expect, it } from "vite-plus/test";
import {
  MinesCatalog,
  catalogHostId,
  type MinesCatalogEntry,
  type MinesCatalogSnapshot,
} from "@t3tools/client-runtime/catalog";
import { buildLibraryRows } from "./MinesLibrary.logic";

describe("library row identity", () => {
  it("keeps pinned shortcuts and their repeated descendants distinct", () => {
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
    expect(entries.filter((row) => row.entry.entity.id === "thread")).toHaveLength(3);
    expect(new Set(entries.map((row) => row.key)).size).toBe(entries.length);
    expect(entries.filter((row) => row.pinned).map((row) => row.entry.entity.id)).toEqual([
      "section",
      "project",
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
      ["library/parent", false],
    ]);
  });

  it("expands nested threads with independent pinned shortcut paths", () => {
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
      ["library/parent", 0],
      ["library/parent/child", 1],
      ["library/parent/child/grandchild", 2],
    ]);
  });

  it("collapses only the chosen parent path and filters hidden descendants", () => {
    const rows = buildLibraryRows(
      nestedThreadSnapshot(),
      new Set(),
      new Set(["library/parent", "library/parent/child"]),
      new Set(["grandchild"]),
    );
    const entries = rows.filter((row) => "entry" in row);
    expect(entries.map((row) => row.key)).toEqual([
      "pins/parent",
      "library/parent",
      "library/parent/child",
    ]);
    expect(entries.find((row) => row.key === "pins/parent")?.open).toBe(false);
    expect(entries.find((row) => row.key === "library/parent")?.open).toBe(true);
    expect(entries.find((row) => row.key === "library/parent/child")?.hasChildren).toBe(false);
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
    ).toEqual([
      [true, 0],
      [false, 1],
    ]);
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
