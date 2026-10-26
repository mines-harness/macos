import { describe, expect, it } from "vite-plus/test";
import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import { catalogDropAllowed, commitCatalogDrop } from "./MinesCatalogTree.drag";

function fixture() {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "work", kind: "section", title: "Work" });
  catalog.upsert({ id: "personal", kind: "section", title: "Personal" });
  catalog.upsert({ id: "project", kind: "project", title: "Mines" });
  catalog.upsert({ id: "thread", kind: "thread", title: "Build" });
  catalog.upsert({ id: "group", kind: "group", title: "Design team" });
  return catalog;
}
const source = (entityId: string) => ({ entityId, accountId: "account" });

describe("Library drop operations", () => {
  it("reorders existing agents without turning unrelated mines into child agents", () => {
    const catalog = fixture();
    catalog.upsert({ id: "agent", kind: "thread", title: "Agent" }, { parentId: "thread" });
    catalog.upsert(
      { id: "second-agent", kind: "thread", title: "Second agent" },
      { parentId: "thread" },
    );
    catalog.upsert({ id: "unrelated", kind: "thread", title: "Unrelated" });
    const target = { parentId: "thread", beforeId: "agent", pinned: false };
    expect(catalogDropAllowed(catalog.getSnapshot(), "unrelated", target)).toBe(false);
    expect(catalogDropAllowed(catalog.getSnapshot(), "second-agent", target)).toBe(true);
  });

  it("reorders sections, nests projects and chats, and preserves their order in another replica", () => {
    const desktop = fixture();
    const phone = new MinesCatalog();
    phone.applyUpdate(desktop.encodeUpdate());
    commitCatalogDrop(
      desktop,
      source("personal"),
      { parentId: null, beforeId: "work", pinned: false },
      "account",
    );
    commitCatalogDrop(desktop, source("project"), { parentId: "work", pinned: false }, "account");
    commitCatalogDrop(desktop, source("group"), { parentId: "project", pinned: false }, "account");
    commitCatalogDrop(
      desktop,
      source("thread"),
      { parentId: "project", beforeId: "group", pinned: false },
      "account",
    );
    phone.applyUpdate(desktop.encodeUpdate(phone.encodeStateVector()));
    expect(phone.getSnapshot().roots).toEqual(desktop.getSnapshot().roots);
    expect(phone.getSnapshot().roots.map((entry) => entry.entity.id)).toEqual(["personal", "work"]);
    expect(
      phone.getSnapshot().roots[1]?.children[0]?.children.map((entry) => entry.entity.id),
    ).toEqual(["thread", "group"]);
  });

  it("drops into Pinned and reorders shortcuts without moving the original hierarchy", () => {
    const catalog = fixture();
    catalog.move("project", "work");
    catalog.move("thread", "project");
    const roots = catalog.getSnapshot().roots;
    commitCatalogDrop(catalog, source("thread"), { parentId: null, pinned: true }, "account");
    commitCatalogDrop(
      catalog,
      source("work"),
      { parentId: null, beforeId: "thread", pinned: true },
      "account",
    );
    expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["work", "thread"]);
    expect(catalog.getSnapshot().roots).toEqual(roots);
  });

  it("rejects forbidden nesting, stale destinations, and an account change during a drag", () => {
    const catalog = fixture();
    const root = { parentId: null, pinned: false };
    expect(() =>
      commitCatalogDrop(catalog, source("work"), { parentId: "project", pinned: false }, "account"),
    ).toThrow();
    expect(() => commitCatalogDrop(catalog, source("work"), root, "different-account")).toThrow(
      /account changed/,
    );
    catalog.removeContainer("project");
    expect(
      catalogDropAllowed(catalog.getSnapshot(), "thread", { parentId: "project", pinned: false }),
    ).toBe(false);
    expect(catalogDropAllowed(catalog.getSnapshot(), "project", root)).toBe(false);
    catalog.applyHostLifecycle({ id: "thread", sequence: 1, state: "archived" });
    expect(catalogDropAllowed(catalog.getSnapshot(), "thread", root)).toBe(false);
  });

  it("does not silently append when a concurrent move removed the insertion anchor", () => {
    const catalog = fixture();
    const target = { parentId: null, beforeId: "thread", pinned: false };
    catalog.move("thread", "project");
    expect(() => commitCatalogDrop(catalog, source("group"), target, "account")).toThrow(
      /destination/,
    );
    catalog.pin("thread");
    catalog.unpin("thread");
    expect(() =>
      commitCatalogDrop(catalog, source("group"), { ...target, pinned: true }, "account"),
    ).toThrow();
  });
});
