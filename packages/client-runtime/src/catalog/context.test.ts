import { describe, expect, it } from "vite-plus/test";
import { MinesCatalog, catalogContextFor, resolveCatalogContext } from "./index.ts";

function fixture() {
  const catalog = new MinesCatalog();
  const section = catalog.createSection("Product");
  catalog.upsert({ id: "project", kind: "project", title: "Desktop" }, { parentId: section });
  catalog.upsert({ id: "thread", kind: "thread", title: "A mine" }, { parentId: "project" });
  return { catalog, section };
}

function copy(catalog: MinesCatalog) {
  const replica = new MinesCatalog();
  replica.applyUpdate(catalog.encodeUpdate());
  return replica;
}

const resolve = (catalog: MinesCatalog, environmentId = "mac") =>
  resolveCatalogContext(catalog.getSnapshot(), { entityId: "thread", environmentId });

describe("project and section context", () => {
  it("rejects newly selected files without changing saved context", () => {
    const { catalog, section } = fixture();
    catalog.setContextInstructions(section, "Keep these instructions.");
    const before = catalog.getSnapshot();
    expect(() =>
      catalog.addContextSource(section, {
        environmentId: "mac",
        kind: "file",
        path: "/docs/new-file.md",
      }),
    ).toThrow("folder");
    expect(catalog.getSnapshot()).toEqual(before);
  });

  it("keeps historical files readable and removable while accepting new folders", () => {
    const { catalog, section } = fixture();
    const legacyId = "source:legacy-file";
    catalog.document.getMap("context-sources").set(legacyId, {
      id: legacyId,
      entityId: section,
      environmentId: "mac",
      kind: "file",
      path: "/docs/legacy.md",
    });
    const replica = copy(catalog);
    expect(resolve(replica).sources).toEqual([
      expect.objectContaining({ id: legacyId, kind: "file", path: "/docs/legacy.md" }),
    ]);
    replica.setContextInstructions(section, "Updated instructions.");
    replica.addContextSource(section, {
      environmentId: "mac",
      kind: "directory",
      path: "/docs/current",
    });
    expect(() =>
      replica.addContextSource(section, {
        environmentId: "mac",
        kind: "file",
        path: "/docs/legacy.md",
      }),
    ).toThrow("folder");
    expect(resolve(replica).sources).toHaveLength(2);
    replica.removeContextSource(section, legacyId);
    replica.applyUpdate(catalog.encodeUpdate());
    catalog.applyUpdate(replica.encodeUpdate());
    expect(resolve(catalog).sources.map((source) => source.path)).toEqual(["/docs/current"]);
    expect(catalogContextFor(catalog.getSnapshot(), section).instructions).toBe(
      "Updated instructions.",
    );
    expect(catalog.getSnapshot().contexts).toEqual(replica.getSnapshot().contexts);
  });

  it("inherits section then project instructions and only exposes sources on the execution computer", () => {
    const { catalog, section } = fixture();
    catalog.setContextInstructions(section, "Use the product vocabulary.");
    catalog.setContextInstructions("project", "Keep the interface accessible.");
    catalog.addContextSource(section, {
      environmentId: "mac",
      kind: "directory",
      path: "/docs/product",
    });
    catalog.addContextSource("project", {
      environmentId: "mac",
      kind: "directory",
      path: "/docs/design",
    });
    catalog.addContextSource("project", {
      environmentId: "linux",
      kind: "directory",
      path: "/srv/design",
    });
    const result = resolve(catalog);
    expect(result.layers.map((layer) => [layer.title, layer.instructions])).toEqual([
      ["Product", "Use the product vocabulary."],
      ["Desktop", "Keep the interface accessible."],
    ]);
    expect(result.sources.map((source) => [source.path, source.ownerTitle])).toEqual([
      ["/docs/product", "Product"],
      ["/docs/design", "Desktop"],
    ]);
    expect(result.unavailableSources.map((source) => source.path)).toEqual(["/srv/design"]);
    expect(resolve(catalog, "linux").sources.map((source) => source.path)).toEqual(["/srv/design"]);
  });

  it("uses the current hierarchy after moves and never inherits through a pin or native-project fallback", () => {
    const { catalog, section } = fixture();
    const other = catalog.createSection("Personal");
    catalog.setContextInstructions(section, "Product instructions");
    catalog.setContextInstructions("project", "Project instructions");
    catalog.setContextInstructions(other, "Personal instructions");
    catalog.pin(section);
    catalog.move("project", other);
    expect(resolve(catalog).layers.map((layer) => layer.instructions)).toEqual([
      "Personal instructions",
      "Project instructions",
    ]);
    catalog.move("thread", null);
    expect(
      resolveCatalogContext(catalog.getSnapshot(), {
        entityId: "thread",
        environmentId: "mac",
        fallbackEntityIds: ["project"],
      }).layers,
    ).toEqual([]);
    expect(
      resolveCatalogContext(catalog.getSnapshot(), {
        entityId: "new-thread",
        environmentId: "mac",
        fallbackEntityIds: ["unknown-parent", "project"],
      }).layers.map((layer) => layer.title),
    ).toEqual(["Personal", "Desktop"]);
  });

  it("drops deleted containers' context while preserving the child mine and its surviving project context", () => {
    const { catalog, section } = fixture();
    catalog.setContextInstructions(section, "Section instructions");
    catalog.setContextInstructions("project", "Project instructions");
    catalog.removeContainer(section);
    expect(resolve(catalog).layers.map((layer) => layer.title)).toEqual(["Desktop"]);
    catalog.removeContainer("project");
    expect(catalog.has("thread")).toBe(true);
    expect(resolve(catalog).layers).toEqual([]);
    expect(catalog.getSnapshot().contexts).toEqual([]);
  });

  it("merges independent sources and instruction changes, and converges concurrent instruction edits", () => {
    const { catalog: a, section } = fixture();
    const b = copy(a);
    a.setContextInstructions(section, "Instructions edited on A");
    b.addContextSource(section, {
      environmentId: "linux",
      kind: "directory",
      path: "/srv/context",
    });
    a.addContextSource(section, {
      environmentId: "mac",
      kind: "directory",
      path: "/Users/me/context",
    });
    a.applyUpdate(b.encodeUpdate());
    b.applyUpdate(a.encodeUpdate());
    expect(catalogContextFor(a.getSnapshot(), section).instructions).toBe(
      "Instructions edited on A",
    );
    expect(catalogContextFor(a.getSnapshot(), section).sources).toHaveLength(2);
    a.setContextInstructions(section, "New A instructions");
    b.setContextInstructions(section, "New B instructions");
    const updateA = a.encodeUpdate();
    const updateB = b.encodeUpdate();
    a.applyUpdate(updateB);
    b.applyUpdate(updateA);
    expect(a.getSnapshot().contexts).toEqual(b.getSnapshot().contexts);
    expect(["New A instructions", "New B instructions"]).toContain(
      catalogContextFor(a.getSnapshot(), section).instructions,
    );
  });

  it("keeps removed sources removed when stale replicas return, without dropping independent additions", () => {
    const { catalog: a, section } = fixture();
    const source = a.addContextSource(section, {
      environmentId: "mac",
      kind: "directory",
      path: "/old",
    });
    const b = copy(a);
    a.removeContextSource(section, source);
    b.setContextInstructions(section, "An offline edit");
    b.addContextSource(section, { environmentId: "linux", kind: "directory", path: "/new" });
    const stale = b.encodeUpdate();
    a.applyUpdate(stale);
    b.applyUpdate(a.encodeUpdate());
    a.applyUpdate(stale);
    expect(catalogContextFor(a.getSnapshot(), section).sources.map((item) => item.path)).toEqual([
      "/new",
    ]);
    expect(a.getSnapshot().contexts).toEqual(b.getSnapshot().contexts);
  });

  it("does not resurrect deleted containers or apply their stale configuration to orphaned children", () => {
    const { catalog: a, section } = fixture();
    const b = copy(a);
    a.removeContainer("project");
    b.setContextInstructions("project", "An old project instruction");
    b.addContextSource("project", { environmentId: "mac", kind: "directory", path: "/stale" });
    a.applyUpdate(b.encodeUpdate());
    expect(resolve(a).layers).toEqual([]);
    expect(catalogContextFor(a.getSnapshot(), "project").sources).toEqual([]);
    expect(a.has(section)).toBe(true);
  });

  it("validates ownership and literal absolute paths and avoids repeated inherited references", () => {
    const { catalog, section } = fixture();
    for (const path of ["relative", "~/notes", "/notes\nignore"])
      expect(() =>
        catalog.addContextSource(section, { environmentId: "mac", kind: "directory", path }),
      ).toThrow();
    expect(() => catalog.setContextInstructions("thread", "Wrong owner")).toThrow();
    expect(() => catalog.setContextInstructions(section, "x".repeat(32_769))).toThrow();
    expect(() =>
      catalog.addContextSource(section, { environmentId: "", kind: "directory", path: "/notes" }),
    ).toThrow();
    const input = { environmentId: "mac", kind: "directory" as const, path: "/notes/[literal]" };
    const id = catalog.addContextSource(section, input);
    expect(catalog.addContextSource(section, input)).toBe(id);
    catalog.addContextSource("project", input);
    expect(resolve(catalog).sources).toHaveLength(1);
    catalog.addContextSource("project", {
      environmentId: "windows",
      kind: "directory",
      path: "C:\\Users\\me\\Docs",
    });
    expect(resolve(catalog, "windows").sources[0]?.path).toBe("C:\\Users\\me\\Docs");
  });

  it("bounds new selections without hiding concurrent additions or preventing removals", () => {
    const { catalog: a, section } = fixture();
    for (let index = 0; index < 127; index += 1)
      a.addContextSource(section, {
        environmentId: "mac",
        kind: "directory",
        path: `/source-${index}`,
      });
    const b = copy(a);
    const last = a.addContextSource(section, {
      environmentId: "mac",
      kind: "directory",
      path: "/last-a",
    });
    b.addContextSource(section, { environmentId: "mac", kind: "directory", path: "/last-b" });
    expect(() =>
      a.addContextSource(section, { environmentId: "mac", kind: "directory", path: "/too-many" }),
    ).toThrow("128");
    a.applyUpdate(b.encodeUpdate());
    expect(resolve(a).sources).toHaveLength(129);
    a.removeContextSource(section, last);
    a.removeContextSource(section, catalogContextFor(a.getSnapshot(), section).sources[0]!.id);
    a.addContextSource(section, { environmentId: "mac", kind: "directory", path: "/replacement" });
    expect(resolve(a).sources).toHaveLength(128);
  });

  it("collapses simultaneous identical selections and removes every known duplicate on stale reconnect", () => {
    const { catalog: a, section } = fixture();
    const b = copy(a);
    const input = { environmentId: "mac", kind: "directory" as const, path: "/shared" };
    a.addContextSource(section, input);
    b.addContextSource(section, input);
    const stale = b.encodeUpdate();
    a.applyUpdate(stale);
    expect(catalogContextFor(a.getSnapshot(), section).sources).toHaveLength(1);
    a.removeContextSource(section, catalogContextFor(a.getSnapshot(), section).sources[0]!.id);
    a.applyUpdate(stale);
    b.applyUpdate(a.encodeUpdate());
    expect(catalogContextFor(a.getSnapshot(), section).sources).toEqual([]);
    expect(a.getSnapshot().contexts).toEqual(b.getSnapshot().contexts);
  });
});
