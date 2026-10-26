import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readCodexAppCatalog } from "./CodexAppCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const nativeFixture = Effect.fn("CodexAppCatalog.test.nativeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "mines-codex-native-catalog-" });
  const databasePath = path.join(home, "state_5.sqlite");
  yield* Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      database.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, rollout_path TEXT, source TEXT, thread_source TEXT, project_id TEXT, agent_nickname TEXT, agent_path TEXT, thread_section_id TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT); CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT)",
      );
      database
        .prepare("INSERT INTO projects VALUES (?, ?)")
        .run("native-project", "Native project");
      database.prepare("INSERT INTO thread_sections VALUES (?, ?)").run("native-studio", "Studio");
      const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run(
        "landing-root",
        "Landing request",
        null,
        path.join(home, "landing-root.jsonl"),
        '"cli"',
        "user",
        null,
        null,
        null,
        null,
      );
      for (let index = 1; index <= 4; index++) {
        insert.run(
          `child-${index}`,
          `Child ${index}`,
          null,
          path.join(home, `child-${index}.jsonl`),
          index === 4
            ? '"cli"'
            : encodeJson({
                subagent: {
                  thread_spawn: {
                    parent_thread_id: "landing-root",
                    ...(index === 1
                      ? { agent_nickname: "Ada" }
                      : index === 2
                        ? { agent_path: "/root/landing/check_sources" }
                        : {}),
                  },
                },
              }),
          "subagent",
          null,
          null,
          null,
          index === 2 ? "native-studio" : null,
        );
      }
      insert.run(
        "nested",
        "Nested child",
        null,
        path.join(home, "nested.jsonl"),
        encodeJson({ subagent: { thread_spawn: { parent_thread_id: "child-1" } } }),
        "subagent",
        null,
        null,
        null,
        null,
      );
      insert.run(
        "assigned",
        "Assigned request",
        null,
        path.join(home, "assigned.jsonl"),
        '"cli"',
        "user",
        null,
        null,
        null,
        null,
      );
      insert.run(
        "native-assigned",
        "Native assigned request",
        null,
        path.join(home, "native-assigned.jsonl"),
        '"cli"',
        "user",
        "native-project",
        null,
        null,
        null,
      );
      insert.run(
        "remote",
        "Remote assignment",
        null,
        path.join(home, "remote.jsonl"),
        '"cli"',
        "user",
        "native-project",
        null,
        null,
        null,
      );
      database
        .prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)")
        .run("landing-root", "child-4", "completed");
    } finally {
      database.close();
    }
  });
  return { home, databasePath };
});

it.layer(NodeServices.layer)("CodexAppCatalog", (it) => {
  it.effect("prefers a native renamed thread name to its raw title and old desktop cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-catalog-" });
      const transcriptPath = path.join(home, "sessions", "rollout.jsonl");
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(path.join(home, "state_5.sqlite"));
        try {
          db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, rollout_path TEXT)");
          db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(
            "native",
            "Raw initial request",
            "Renamed native thread",
            transcriptPath,
          );
        } finally {
          db.close();
        }
      });
      yield* fs.writeFileString(
        path.join(home, ".codex-global-state.json"),
        JSON.stringify({ "thread-titles": { titles: { native: "Old desktop cache" } } }),
      );
      const catalog = yield* readCodexAppCatalog(home);
      expect(catalog.resolve("/workspace", transcriptPath, "native").threadTitle).toBe(
        "Renamed native thread",
      );
    }),
  );

  it.effect("uses read-only SQLite titles when desktop organization is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-catalog-" });
      const databasePath = path.join(home, "state_5.sqlite");
      const transcriptPath = path.join(home, "sessions", "rollout.jsonl");
      yield* Effect.sync(() => {
        const database = new NodeSqlite.DatabaseSync(databasePath);
        try {
          database.exec("CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT)");
          database
            .prepare("INSERT INTO threads VALUES (?, ?, ?)")
            .run("native", "Actual desktop title", transcriptPath);
        } finally {
          database.close();
        }
      });
      yield* fs.writeFileString(path.join(home, ".codex-global-state.json"), "malformed");
      const before = yield* fs.readFile(databasePath);
      const catalog = yield* readCodexAppCatalog(home);
      expect(catalog.resolve("/workspace", transcriptPath).threadTitle).toBe(
        "Actual desktop title",
      );
      expect(catalog.reports).toMatchObject([{ source: "codex", status: "partial" }]);
      expect(yield* fs.readFile(databasePath)).toEqual(before);
    }),
  );

  it.effect(
    "uses explicit local assignments and refuses cwd fallback for an explicitly remote thread",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-catalog-" });
        yield* fs.writeFileString(
          path.join(home, ".codex-global-state.json"),
          JSON.stringify({
            "local-projects": {
              local: {
                id: "local",
                name: "Named project",
                rootPaths: ["/workspace", "/second-root"],
              },
            },
            "thread-project-assignments": {
              local: { projectKind: "local", projectId: "local" },
              remote: { projectKind: "remote", projectId: "remote-project" },
            },
          }),
        );
        const catalog = yield* readCodexAppCatalog(home);
        expect(catalog.resolve("/second-root", "/transcript", "local").projectTitle).toBe(
          "Named project",
        );
        expect(catalog.resolve("/workspace", "/transcript", "remote").projectTitle).toBeUndefined();
      }),
  );

  it.effect(
    "keeps a landing thread and its four native children projectless while preserving exact parent/root links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home, databasePath } = yield* nativeFixture();
        yield* fs.writeFileString(
          path.join(home, ".codex-global-state.json"),
          encodeJson({
            "local-projects": {
              desktop: {
                id: "desktop",
                name: "Desktop project",
                rootPaths: ["/workspace", "/second-root"],
              },
            },
            "thread-project-assignments": {
              assigned: { projectKind: "local", projectId: "desktop" },
              remote: { projectKind: "remote", projectId: "remote-project" },
            },
            "electron-persisted-atom-state": {
              "sidebar-custom-sections-v3": {
                account: {
                  sections: [
                    {
                      id: "studio",
                      name: "Studio",
                      hostSectionIds: { local: "native-studio" },
                      itemKeys: ["codex:thread:local:child-2"],
                    },
                  ],
                  sectionOrder: ["custom:studio"],
                },
              },
            },
          }),
        );
        const before = yield* fs.readFile(databasePath);
        const catalog = yield* readCodexAppCatalog(home);
        const root = catalog.resolve("/workspace", path.join(home, "landing-root.jsonl"));
        expect(root).toMatchObject({
          sourceThreadId: "landing-root",
          sourceRootThreadId: "landing-root",
          kind: "thread",
          sourceProject: null,
        });
        expect(root.projectId).toBeUndefined();
        for (let index = 1; index <= 4; index++) {
          const child = catalog.resolve("/workspace", path.join(home, `child-${index}.jsonl`));
          expect(child).toMatchObject({
            sourceThreadId: `child-${index}`,
            sourceParentThreadId: "landing-root",
            sourceRootThreadId: "landing-root",
            kind: "subagent",
            sourceProject: null,
          });
          expect(child.projectTitle).toBeUndefined();
        }
        expect(catalog.resolve("/workspace", "/transcript", "child-1").agentName).toBe("Ada");
        expect(catalog.resolve("/workspace", "/transcript", "child-2")).toMatchObject({
          agentName: "check_sources",
          threadSection: { title: "Studio" },
          sourceProject: null,
        });
        expect(catalog.resolve("/workspace", "/transcript", "nested")).toMatchObject({
          sourceParentThreadId: "child-1",
          sourceRootThreadId: "landing-root",
          kind: "subagent",
        });
        expect(catalog.resolve("/workspace", "/transcript", "assigned").sourceProject).toEqual({
          id: "desktop",
          title: "Desktop project",
        });
        expect(
          catalog.resolve("/workspace", "/transcript", "native-assigned").sourceProject,
        ).toEqual({ id: "native-project", title: "Native project" });
        expect(
          catalog.resolve("/workspace", "/transcript", "remote").sourceProject,
        ).toBeUndefined();
        expect(yield* fs.readFile(databasePath)).toEqual(before);
      }),
  );

  it.effect(
    "uses explicit desktop assignments before native IDs and bridges native project IDs without cwd guesses",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home } = yield* nativeFixture();
        yield* fs.writeFileString(
          path.join(home, ".codex-global-state.json"),
          encodeJson({
            "local-projects": {
              desktop: { id: "desktop", name: "Desktop assignment", rootPaths: ["/workspace"] },
              legacy: { id: "legacy", name: "Desktop native project", rootPaths: ["/elsewhere"] },
            },
            "thread-project-assignments": {
              "native-assigned": { projectKind: "local", projectId: "desktop" },
            },
            "app-server-project-id-by-legacy-project-id-by-host": {
              [`local:${home}`]: { legacy: "native-project" },
            },
          }),
        );
        const catalog = yield* readCodexAppCatalog(home);
        expect(
          catalog.resolve("/workspace", "/transcript", "native-assigned").sourceProject,
        ).toEqual({ id: "desktop", title: "Desktop assignment" });
        expect(catalog.resolve("/workspace", "/transcript", "remote").sourceProject).toEqual({
          id: "legacy",
          title: "Desktop native project",
        });
        expect(
          catalog.resolve("/workspace", "/transcript", "landing-root").sourceProject,
        ).toBeNull();
      }),
  );

  it.effect(
    "distinguishes unknown project metadata from known unassigned threads and supports native section fallback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const unknownHome = yield* fs.makeTempDirectoryScoped({
          prefix: "mines-codex-unknown-catalog-",
        });
        const unknown = yield* readCodexAppCatalog(unknownHome);
        expect(
          unknown.resolve("/workspace", "/transcript", "unavailable").sourceProject,
        ).toBeUndefined();
        yield* fs.writeFileString(path.join(unknownHome, ".codex-global-state.json"), "{}");
        const oldState = yield* readCodexAppCatalog(unknownHome);
        expect(
          oldState.resolve("/workspace", "/transcript", "unassigned").sourceProject,
        ).toBeUndefined();
        yield* fs.writeFileString(
          path.join(unknownHome, ".codex-global-state.json"),
          encodeJson({ "thread-project-assignments": {} }),
        );
        const knownEmpty = yield* readCodexAppCatalog(unknownHome);
        expect(
          knownEmpty.resolve("/workspace", "/transcript", "unassigned").sourceProject,
        ).toBeNull();
        const { home } = yield* nativeFixture();
        const native = yield* readCodexAppCatalog(home);
        expect(
          native.resolve("/workspace", "/transcript", "landing-root").sourceProject,
        ).toBeUndefined();
        expect(
          native.resolve("/workspace", "/transcript", "native-assigned").sourceProject,
        ).toEqual({ id: "native-project", title: "Native project" });
        expect(native.resolve("/workspace", "/transcript", "child-2").threadSection?.title).toBe(
          "Studio",
        );
        yield* fs.writeFileString(
          path.join(home, ".codex-global-state.json"),
          encodeJson({
            "thread-project-assignments": {
              "landing-root": { projectKind: "local", projectId: "missing-project" },
              "native-assigned": { projectKind: "local", projectId: "missing-project" },
            },
          }),
        );
        const dangling = yield* readCodexAppCatalog(home);
        expect(
          dangling.resolve("/workspace", "/transcript", "landing-root").sourceProject,
        ).toBeUndefined();
        expect(
          dangling.resolve("/workspace", "/transcript", "native-assigned").sourceProject,
        ).toEqual({ id: "native-project", title: "Native project" });
      }),
  );

  it.effect("rejects self-parent and cyclic lineage while retaining a missing-parent anchor", () =>
    Effect.gen(function* () {
      const { home, databasePath } = yield* nativeFixture();
      yield* Effect.sync(() => {
        const database = new NodeSqlite.DatabaseSync(databasePath);
        try {
          const update = database.prepare("UPDATE threads SET source = ? WHERE id = ?");
          update.run(
            encodeJson({ subagent: { thread_spawn: { parent_thread_id: "child-1" } } }),
            "landing-root",
          );
          update.run(
            encodeJson({ subagent: { thread_spawn: { parent_thread_id: "missing-parent" } } }),
            "child-3",
          );
          update.run(
            encodeJson({ subagent: { thread_spawn: { parent_thread_id: "child-4" } } }),
            "child-4",
          );
        } finally {
          database.close();
        }
      });
      const catalog = yield* readCodexAppCatalog(home);
      expect(
        catalog.resolve("/workspace", "/transcript", "child-1").sourceParentThreadId,
      ).toBeUndefined();
      expect(catalog.resolve("/workspace", "/transcript", "child-1").sourceRootThreadId).toBe(
        "child-1",
      );
      expect(
        catalog.resolve("/workspace", "/transcript", "child-4").sourceParentThreadId,
      ).toBeUndefined();
      expect(catalog.resolve("/workspace", "/transcript", "child-3")).toMatchObject({
        sourceParentThreadId: "missing-parent",
        sourceRootThreadId: "missing-parent",
      });
      expect(catalog.reports).toMatchObject([{ source: "codex", status: "partial" }]);
    }),
  );
});
