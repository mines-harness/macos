// @effect-diagnostics nodeBuiltinImport:off -- SQLite fixtures and source-byte comparisons use native file and path APIs.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { discoverT3CodeSessions, loadT3CodeSession } from "./T3CodeAgentSessions.ts";

const THREAD_ID = "57a096b1-f938-4faf-a55e-57e5a4e4ef8b";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-02T00:00:00.000Z";
const decodeProjection = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
        createdAt: Schema.String,
      }),
    ),
  ),
);
const decodeArchive = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sourceDatabase: Schema.String,
      table: Schema.String,
      row: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

function fixture(
  filePath: string,
  options: {
    v2?: boolean;
    driver?: string;
    customInstance?: boolean;
    messages?: number;
    text?: string;
    attachments?: boolean;
    events?: boolean;
  } = {},
) {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(filePath);
  try {
    database.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, model_selection_json TEXT, worktree_path TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, role TEXT, text TEXT, is_streaming INTEGER, attachments_json TEXT, context_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT, summary TEXT, payload_json TEXT, created_at TEXT);
      CREATE TABLE auth_sessions (secret TEXT);
      CREATE TABLE orchestration_v2_effect_outbox (secret TEXT);
      INSERT INTO auth_sessions VALUES ('excluded-auth-sentinel');
      INSERT INTO orchestration_v2_effect_outbox VALUES ('excluded-outbox-sentinel');
    `);
    database
      .prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?, ?)")
      .run("project-1", "A named T3 project", "/fixture/workspace", CREATED_AT, UPDATED_AT);
    database.prepare("INSERT INTO projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      THREAD_ID,
      "project-1",
      "Legacy title",
      JSON.stringify({
        instanceId: options.customInstance ? "work-account" : (options.driver ?? "claudeAgent"),
        model: "historical-model",
      }),
      null,
      CREATED_AT,
      UPDATED_AT,
      null,
    );
    const message = database.prepare(
      "INSERT INTO projection_thread_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 0; index < (options.messages ?? 3); index++) {
      message.run(
        `message-${String(index).padStart(4, "0")}`,
        THREAD_ID,
        "turn-1",
        index % 2 ? "assistant" : "user",
        options.text ?? `Legacy message ${index}`,
        0,
        options.attachments && index === 0
          ? '[ {"id":"old-file", "type":"file", "path":"/not-fetched", "url":"https://invalid.example/private"} ]'
          : "[]",
        index === 0
          ? '{ "version":1,"records":[{"type":"future-context","raw":"preserved"}] }'
          : null,
        DateTime.formatIso(DateTime.makeUnsafe(Date.parse(CREATED_AT) + index * 1_000)),
        UPDATED_AT,
      );
    }
    database
      .prepare("INSERT INTO projection_thread_activities VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "activity-1",
        THREAD_ID,
        "turn-1",
        "info",
        "tool",
        "Tool activity",
        '{ "tool":"old-tool", "output":{"path":"/not-fetched"} }',
        CREATED_AT,
      );
    if (options.v2) {
      database.exec(`
        CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, provider_instance_id TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
        CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT);
        CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, node_id TEXT, parent_item_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
      `);
      database
        .prepare(
          "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          THREAD_ID,
          "project-1",
          "Renamed V2 title",
          options.customInstance ? "work-account" : (options.driver ?? "claudeAgent"),
          options.customInstance ? "work-account" : (options.driver ?? "claudeAgent"),
          CREATED_AT,
          UPDATED_AT,
          null,
          null,
          JSON.stringify({
            providerInstanceId: options.customInstance
              ? "work-account"
              : (options.driver ?? "claudeAgent"),
            modelSelection: {
              instanceId: options.customInstance
                ? "work-account"
                : (options.driver ?? "claudeAgent"),
              model: "historical-v2-model",
            },
          }),
        );
      database
        .prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "message-0002",
          THREAD_ID,
          "user",
          "2026-01-01T00:00:02.000Z",
          UPDATED_AT,
          JSON.stringify({ text: "Latest V2 shell preview", attachments: [] }),
        );
      database
        .prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "message-new",
          THREAD_ID,
          "assistant",
          "2026-01-01T00:00:04.000Z",
          UPDATED_AT,
          JSON.stringify({ text: "New V2 message", attachments: [] }),
        );
      database
        .prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "system-1",
          THREAD_ID,
          "system",
          CREATED_AT,
          UPDATED_AT,
          JSON.stringify({ text: "System record", attachments: [] }),
        );
      database
        .prepare(
          "INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "tool-1",
          THREAD_ID,
          null,
          null,
          null,
          2,
          "dynamic_tool",
          "completed",
          UPDATED_AT,
          '{ "type":"dynamic_tool", "input":{"opaque":true}, "output":{"original":[1,2]} }',
        );
    }
    if (options.events) {
      database.exec(
        "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_id TEXT, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, occurred_at TEXT, payload_json TEXT, metadata_json TEXT, application_event_version INTEGER, command_id TEXT, causation_event_id TEXT, correlation_id TEXT, stream_version INTEGER, actor_kind TEXT)",
      );
      database
        .prepare(
          "INSERT INTO orchestration_events (sequence, event_id, aggregate_kind, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          1,
          "event-1",
          "thread",
          THREAD_ID,
          "message.updated",
          CREATED_AT,
          '{ "original-event":true }',
          '{ "original-metadata":true }',
          2,
        );
      database
        .prepare(
          "INSERT INTO orchestration_events (sequence, event_id, aggregate_kind, stream_id, event_type, occurred_at, payload_json, metadata_json, application_event_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          2,
          "unrelated",
          "thread",
          "other-thread",
          "message.updated",
          CREATED_AT,
          '{"excluded":"unrelated-event"}',
          "{}",
          2,
        );
      database
        .prepare(
          "UPDATE orchestration_events SET command_id = ?, causation_event_id = ?, correlation_id = ?, stream_version = ?, actor_kind = ? WHERE event_id = ?",
        )
        .run("command-1", "cause-1", "correlation-1", 7, "provider", "event-1");
    }
  } finally {
    database.close();
  }
}

const environment = Effect.fn("T3CodeAgentSessions.test.environment")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-t3code-source-" });
  const destination = yield* fs.makeTempDirectoryScoped({ prefix: "mines-t3code-destination-" });
  return {
    homeDir,
    destination,
    source: NodePath.join(homeDir, ".t3", "userdata", "statev2.sqlite"),
    layer: ServerConfig.layerTest(homeDir, destination),
  };
});

const projections = Effect.fn("T3CodeAgentSessions.test.projections")(function* (
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* Effect.forEach(files, (file) => fs.readFileString(file))).flatMap((contents) =>
    decodeProjection(contents),
  );
});

describe("T3 Code history reader", () => {
  it.effect(
    "imports V1 text and archives original activity/context/attachment/event rows without changing the source",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        yield* Effect.sync(() => fixture(env.source, { attachments: true, events: true }));
        const before = yield* Effect.sync(() => NodeFS.readFileSync(env.source));
        const scan = yield* discoverT3CodeSessions({}, env.homeDir);
        expect(scan.candidates).toHaveLength(1);
        const candidate = scan.candidates[0]!;
        expect(candidate.projectTitle).toBe("A named T3 project");
        expect(candidate.providerDriver).toBe("claudeAgent");
        expect(candidate.providerInstanceId).toBe("t3code");
        const result = yield* loadT3CodeSession(candidate).pipe(Effect.provide(env.layer));
        expect(result.thread.nativeContinuation).toBe(false);
        expect(result.thread.providerInstanceId).toBe("claudeAgent");
        expect(result.thread.model).toBe("historical-model");
        expect(result.thread.partial).toBe(true);
        expect(
          (yield* projections(result.thread.projectionFiles!)).map((message) => message.text),
        ).toEqual(["Legacy message 0", "Legacy message 1", "Legacy message 2"]);
        const fs = yield* FileSystem.FileSystem;
        const archive = yield* fs.readFileString(result.archiveFilePath);
        const rows = archive
          .trim()
          .split("\n")
          .map((line) => decodeArchive(line));
        expect(
          rows.find((record) => record.table === "projection_thread_messages")?.row.context_json,
        ).toBe('{ "version":1,"records":[{"type":"future-context","raw":"preserved"}] }');
        expect(
          rows.find((record) => record.table === "projection_thread_activities")?.row.payload_json,
        ).toBe('{ "tool":"old-tool", "output":{"path":"/not-fetched"} }');
        expect(
          rows.find((record) => record.table === "orchestration_events")?.row.payload_json,
        ).toBe('{ "original-event":true }');
        expect(rows.find((record) => record.table === "orchestration_events")?.row).toMatchObject({
          command_id: "command-1",
          causation_event_id: "cause-1",
          correlation_id: "correlation-1",
          stream_version: 7,
          actor_kind: "provider",
        });
        expect(archive).not.toContain("excluded-auth-sentinel");
        expect(archive).not.toContain("excluded-outbox-sentinel");
        expect(archive).not.toContain("unrelated-event");
        expect(yield* Effect.sync(() => NodeFS.readFileSync(env.source))).toEqual(before);
        expect(yield* fs.readDirectory(NodePath.dirname(env.source))).toEqual(["statev2.sqlite"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "unions V2 shell previews with complete copied V1 messages and deduplicates sibling databases",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        const legacyPath = NodePath.join(NodePath.dirname(env.source), "state.sqlite");
        yield* Effect.sync(() => {
          fixture(legacyPath);
          fixture(env.source, { v2: true });
        });
        const scan = yield* discoverT3CodeSessions(
          { exportPaths: [legacyPath, env.source] },
          env.homeDir,
        );
        expect(scan.candidates).toHaveLength(1);
        const candidate = scan.candidates[0]!;
        expect(candidate.title).toBe("Renamed V2 title");
        expect(candidate.databasePaths).toEqual([
          yield* (yield* FileSystem.FileSystem).realPath(env.source),
          yield* (yield* FileSystem.FileSystem).realPath(legacyPath),
        ]);
        const result = yield* loadT3CodeSession(candidate).pipe(Effect.provide(env.layer));
        expect(
          (yield* projections(result.thread.projectionFiles!)).map((message) => message.text),
        ).toEqual([
          "Legacy message 0",
          "Legacy message 1",
          "Latest V2 shell preview",
          "New V2 message",
        ]);
        expect(result.thread.messageCount).toBe(4);
        expect(result.thread.model).toBe("historical-v2-model");
        const archive = yield* (yield* FileSystem.FileSystem).readFileString(
          result.archiveFilePath,
        );
        const rows = archive
          .trim()
          .split("\n")
          .map((line) => decodeArchive(line));
        expect(
          rows.find((record) => record.table === "orchestration_v2_projection_turn_items")?.row
            .payload_json,
        ).toBe('{ "type":"dynamic_tool", "input":{"opaque":true}, "output":{"original":[1,2]} }');
        expect(archive).toContain("System record");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pages every message beyond the former 32 MiB history limit", () =>
    Effect.gen(function* () {
      const env = yield* environment();
      const body = "x".repeat(512 * 1024);
      yield* Effect.sync(() => fixture(env.source, { messages: 66, text: body }));
      const scan = yield* discoverT3CodeSessions({}, env.homeDir);
      const result = yield* loadT3CodeSession(scan.candidates[0]!).pipe(Effect.provide(env.layer));
      expect(result.thread.messageCount).toBe(66);
      expect(result.thread.projectionFiles).toHaveLength(2);
      const fs = yield* FileSystem.FileSystem;
      const first = decodeProjection(yield* fs.readFileString(result.thread.projectionFiles![0]!));
      const second = decodeProjection(yield* fs.readFileString(result.thread.projectionFiles![1]!));
      expect(first).toHaveLength(64);
      expect(second).toHaveLength(2);
      expect(second[1]?.text.length).toBe(body.length);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "accepts explicit moved databases and rejects unknown schemas/providers without guessing",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        const moved = NodePath.join(env.homeDir, "export", "moved.sqlite");
        yield* Effect.sync(() => fixture(moved, { driver: "codex" }));
        const explicit = yield* discoverT3CodeSessions({ exportPaths: [moved] }, env.homeDir);
        expect(explicit.candidates[0]?.providerDriver).toBe("codex");
        const unknown = NodePath.join(env.homeDir, "unknown.sqlite");
        yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(unknown);
          database.exec("CREATE TABLE auth_sessions (secret TEXT)");
          database.close();
        });
        const unsupported = yield* discoverT3CodeSessions({ exportPaths: [unknown] }, env.homeDir);
        expect(unsupported.candidates).toEqual([]);
        expect(unsupported.reports[0]?.status).toBe("unsupported");
        yield* Effect.sync(() => fixture(env.source, { customInstance: true }));
        const unknownDriver = yield* discoverT3CodeSessions({}, env.homeDir);
        expect(unknownDriver.candidates).toEqual([]);
        expect(unknownDriver.reports[0]?.status).toBe("unsupported");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never scans the current .mines directory as old T3 Code history", () =>
    Effect.gen(function* () {
      const env = yield* environment();
      yield* Effect.sync(() =>
        fixture(NodePath.join(env.homeDir, ".mines", "userdata", "statev2.sqlite")),
      );
      const scan = yield* discoverT3CodeSessions({}, env.homeDir);
      expect(scan.candidates).toEqual([]);
      expect(scan.reports[0]?.status).toBe("unavailable");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not resurrect a V2-deleted thread from the sibling V1 database", () =>
    Effect.gen(function* () {
      const env = yield* environment();
      yield* Effect.sync(() => {
        fixture(NodePath.join(NodePath.dirname(env.source), "state.sqlite"));
        fixture(env.source, { v2: true });
        const database = new NodeSqlite.DatabaseSync(env.source);
        database
          .prepare("UPDATE orchestration_v2_projection_threads SET deleted_at = ?")
          .run(UPDATED_AT);
        database.close();
      });
      const scan = yield* discoverT3CodeSessions({}, env.homeDir);
      expect(scan.candidates).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "identifies custom instances only through a supported persisted driver and sanitizes generated titles",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        yield* Effect.sync(() => {
          fixture(env.source, { v2: true, customInstance: true });
          const database = new NodeSqlite.DatabaseSync(env.source);
          database.exec(
            "CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, provider_instance_id TEXT)",
          );
          database
            .prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)")
            .run(THREAD_ID, "claudeAgent", "work-account");
          database
            .prepare("UPDATE orchestration_v2_projection_threads SET title = ?")
            .run("# AGENTS.md instructions for /fixture");
          database.close();
        });
        const scan = yield* discoverT3CodeSessions({}, env.homeDir);
        expect(scan.candidates[0]?.providerDriver).toBe("claudeAgent");
        expect(scan.candidates[0]?.title).toBe("Imported mine");
        const loaded = yield* loadT3CodeSession(scan.candidates[0]!).pipe(
          Effect.provide(env.layer),
        );
        expect(loaded.thread.title).toBe("Imported mine");
        expect(loaded.thread.providerInstanceId).toBe("claudeAgent");
        yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(env.source);
          database
            .prepare("UPDATE orchestration_v2_projection_provider_threads SET driver = ?")
            .run("unrecognized-driver");
          database.close();
        });
        const unsupported = yield* discoverT3CodeSessions({}, env.homeDir);
        expect(unsupported.candidates).toEqual([]);
        expect(unsupported.reports[0]?.status).toBe("unsupported");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses one read snapshot for archive and paged messages while the source receives a new message",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        yield* Effect.sync(() => fixture(env.source, { messages: 65 }));
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const database = new NodeSqlite.DatabaseSync(env.source);
            database.exec("PRAGMA journal_mode = WAL");
            return database;
          }),
          (database) => Effect.sync(() => database.close()),
        );
        const scan = yield* discoverT3CodeSessions({}, env.homeDir);
        const fs = yield* FileSystem.FileSystem;
        let appended = false;
        const snapshotFs = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (filePath, contents, options) =>
            Effect.gen(function* () {
              if (!appended && filePath.endsWith("messages-0.json")) {
                appended = true;
                yield* Effect.sync(() =>
                  writer.exec(
                    `INSERT INTO projection_thread_messages SELECT 'late-message', thread_id, turn_id, 'user', 'Late external message', 0, '[]', NULL, '2026-01-01T00:02:00.000Z', updated_at FROM projection_thread_messages LIMIT 1`,
                  ),
                );
              }
              return yield* fs.writeFileString(filePath, contents, options);
            }),
        });
        const result = yield* loadT3CodeSession(scan.candidates[0]!).pipe(
          Effect.provide(env.layer),
          Effect.provideService(FileSystem.FileSystem, snapshotFs),
        );
        expect(appended).toBe(true);
        expect(result.thread.messageCount).toBe(65);
        expect(
          (yield* projections(result.thread.projectionFiles!)).some(
            (message) => message.text === "Late external message",
          ),
        ).toBe(false);
        expect(yield* fs.readFileString(result.archiveFilePath)).not.toContain(
          "Late external message",
        );
        expect(
          yield* Effect.sync(
            () =>
              writer.prepare("SELECT COUNT(*) AS count FROM projection_thread_messages").get()
                ?.count,
          ),
        ).toBe(66);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "scans, loads every page, archives, and recognizes a completed T3 import through the scanner service",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        yield* Effect.sync(() => fixture(env.source, { messages: 65 }));
        const scanner = yield* AgentSessionScanner.AgentSessionScanner.pipe(
          Effect.provide(
            AgentSessionScanner.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  env.layer,
                  ServerSettings.layerTest(),
                  Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
                ),
              ),
            ),
          ),
          Effect.provideService(HostProcess.HomeDirectory, env.homeDir),
        );
        const input = { sources: ["t3code" as const], exportPaths: [env.source] };
        const scan = yield* scanner.scan(input);
        expect(scan.candidates).toHaveLength(1);
        const candidate = scan.candidates[0]!;
        expect(candidate.title).toBe("A named T3 project");
        expect(candidate.sources).toEqual(["t3code"]);
        expect(candidate.sourceWorkspaceRoot).toBe("/fixture/workspace");
        const selected = { ...input, sourceWorkspaceRoot: candidate.sourceWorkspaceRoot };
        const outcomes = yield* scanner
          .recentThreads(candidate.path, [], selected)
          .pipe(Stream.runCollect);
        const first = outcomes[0];
        if (first?._tag !== "Importable")
          return yield* Effect.die("Expected an importable T3 thread");
        expect(first.source.provider).toBe("t3code");
        expect(first.source.providerInstanceId).toBe("t3code");
        expect(first.thread.providerDriver).toBe("claudeAgent");
        expect(first.thread.nativeContinuation).toBe(false);
        expect(first.thread.archiveAttachments?.length).toBeGreaterThan(0);
        const importedMessages = yield* scanner
          .streamMessages(first.thread)
          .pipe(Stream.runCollect);
        expect(importedMessages).toHaveLength(65);
        expect(importedMessages[64]?.text).toBe("Legacy message 64");
        const repeated = yield* scanner
          .recentThreads(candidate.path, [first.source], selected)
          .pipe(Stream.runCollect);
        expect(repeated.map((outcome) => outcome._tag)).toEqual(["AlreadyImported"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps non-UUID history identities stable across relocated database copies", () =>
    Effect.gen(function* () {
      const env = yield* environment();
      const original = NodePath.join(env.homeDir, "original.sqlite");
      const relocated = NodePath.join(env.homeDir, "relocated", "export.sqlite");
      yield* Effect.sync(() => {
        fixture(original);
        const database = new NodeSqlite.DatabaseSync(original);
        database.exec(
          "UPDATE projection_threads SET thread_id = 'legacy-durable-id'; UPDATE projection_thread_messages SET thread_id = 'legacy-durable-id'; UPDATE projection_thread_activities SET thread_id = 'legacy-durable-id'",
        );
        database.close();
      });
      const before = yield* discoverT3CodeSessions({ exportPaths: [original] }, env.homeDir);
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(NodePath.dirname(relocated), { recursive: true });
        NodeFS.copyFileSync(original, relocated);
      });
      const after = yield* discoverT3CodeSessions(
        { exportPaths: [original, relocated] },
        env.homeDir,
      );
      expect(after.candidates).toHaveLength(1);
      expect(after.candidates[0]?.sessionId).toBe(before.candidates[0]?.sessionId);
      expect(after.candidates[0]?.databasePaths).toHaveLength(2);
      const loaded = yield* loadT3CodeSession(after.candidates[0]!).pipe(Effect.provide(env.layer));
      expect(loaded.thread.messageCount).toBe(3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a source provider changed after discovery", () =>
    Effect.gen(function* () {
      const env = yield* environment();
      yield* Effect.sync(() => fixture(env.source));
      const scan = yield* discoverT3CodeSessions({}, env.homeDir);
      yield* Effect.sync(() => {
        const database = new NodeSqlite.DatabaseSync(env.source);
        database
          .prepare("UPDATE projection_threads SET model_selection_json = ?")
          .run('{"instanceId":"codex","model":"changed-provider-model"}');
        database.close();
      });
      const result = yield* loadT3CodeSession(scan.candidates[0]!).pipe(
        Effect.provide(env.layer),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(
        yield* (yield* FileSystem.FileSystem).readDirectory(
          NodePath.join(env.destination, "imported-history"),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects a thread moved after discovery and removes its incomplete destination export",
    () =>
      Effect.gen(function* () {
        const env = yield* environment();
        yield* Effect.sync(() => fixture(env.source));
        const scan = yield* discoverT3CodeSessions({}, env.homeDir);
        yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(env.source);
          database
            .prepare("UPDATE projection_projects SET workspace_root = ?")
            .run("/fixture/other-workspace");
          database.close();
        });
        const result = yield* loadT3CodeSession(scan.candidates[0]!).pipe(
          Effect.provide(env.layer),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readDirectory(NodePath.join(env.destination, "imported-history"))).toEqual(
          [],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
