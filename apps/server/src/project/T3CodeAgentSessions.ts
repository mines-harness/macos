// @effect-diagnostics nodeBuiltinImport:off -- SQLite row normalization uses synchronous hashes for stable source identities.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import {
  AgentSessionScanError,
  ProviderDriverKind,
  ProviderInstanceId,
  isAgentSessionGeneratedContextTitle,
  type AgentSessionScanInput,
  type AgentSessionSourceReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";
import * as ServerConfig from "../config.ts";

const PAGE_SIZE = 64;
const SUPPORTED_DRIVERS = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const TABLES = {
  projection_projects: [
    "project_id",
    "title",
    "workspace_root",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "model",
    "model_selection_json",
    "runtime_mode",
    "interaction_mode",
    "branch",
    "worktree_path",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
  ],
  orchestration_v2_projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "default_provider",
    "provider_instance_id",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
    "payload_json",
  ],
  projection_thread_messages: [
    "message_id",
    "thread_id",
    "turn_id",
    "role",
    "text",
    "is_streaming",
    "attachments_json",
    "context_json",
    "created_at",
    "updated_at",
  ],
  orchestration_v2_projection_messages: [
    "message_id",
    "thread_id",
    "role",
    "created_at",
    "updated_at",
    "payload_json",
  ],
  orchestration_v2_projection_turn_items: [
    "turn_item_id",
    "thread_id",
    "run_id",
    "node_id",
    "parent_item_id",
    "ordinal",
    "type",
    "status",
    "updated_at",
    "payload_json",
  ],
  projection_thread_activities: [
    "activity_id",
    "thread_id",
    "turn_id",
    "tone",
    "kind",
    "summary",
    "payload_json",
    "created_at",
  ],
  orchestration_events: [
    "sequence",
    "event_id",
    "aggregate_kind",
    "stream_id",
    "stream_version",
    "command_id",
    "causation_event_id",
    "correlation_id",
    "actor_kind",
    "event_type",
    "occurred_at",
    "payload_json",
    "metadata_json",
    "application_event_version",
  ],
  orchestration_v2_events: [
    "sequence",
    "event_id",
    "thread_id",
    "command_id",
    "run_id",
    "node_id",
    "raw_event_id",
    "provider",
    "driver",
    "provider_instance_id",
    "event_type",
    "occurred_at",
    "payload_json",
  ],
  orchestration_v2_projection_provider_threads: [
    "thread_id",
    "driver",
    "provider",
    "provider_instance_id",
    "updated_at",
  ],
  projection_thread_sessions: ["thread_id", "provider_name"],
} as const;
type Table = keyof typeof TABLES;
type Row = Record<string, NodeSqlite.SQLOutputValue>;
interface Snapshot {
  readonly database: NodeSqlite.DatabaseSync;
  readonly columns: ReadonlyMap<Table, ReadonlySet<string>>;
  readonly filePath: string;
}

export interface T3CodeSessionCandidate {
  readonly source: "t3code";
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDriver: ProviderDriverKind;
  readonly filePath: string;
  readonly databasePaths: ReadonlyArray<string>;
  readonly cwd: string;
  readonly title: string;
  readonly projectTitle?: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mtimeMs: number;
  readonly model: string | null;
}

function string(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: string | null): Record<string, unknown> {
  const decoded = decodeJson(value);
  return object(Option.isSome(decoded) ? decoded.value : undefined);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function iso(value: string | null, fallback: string): string {
  const time = value === null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? DateTime.formatIso(DateTime.makeUnsafe(time)) : fallback;
}

function historicalTitle(row: Row) {
  const title = string(row, "title")?.trim();
  return title && !isAgentSessionGeneratedContextTitle(title) ? title : "Imported mine";
}

function openSnapshot(filePath: string): Snapshot {
  const database = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
  try {
    database.exec("BEGIN");
    const columns = new Map<Table, ReadonlySet<string>>();
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${Object.keys(TABLES)
          .map(() => "?")
          .join(",")})`,
      )
      .all(...Object.keys(TABLES));
    for (const table of Object.keys(TABLES) as Table[]) {
      if (!tables.some((row) => row.name === table)) continue;
      columns.set(
        table,
        new Set(
          database
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
        ),
      );
    }
    return { database, columns, filePath };
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function closeSnapshot(snapshot: Snapshot) {
  try {
    snapshot.database.exec("ROLLBACK");
  } finally {
    snapshot.database.close();
  }
}

function has(snapshot: Snapshot, table: Table, ...columns: string[]) {
  return columns.every((column) => snapshot.columns.get(table)?.has(column));
}

function selection(snapshot: Snapshot, table: Table, prefix = "") {
  return TABLES[table]
    .map((column) => (has(snapshot, table, column) ? `${prefix}${column}` : `NULL AS ${column}`))
    .join(", ");
}

function historicalDriver(snapshot: Snapshot, row: Row): ProviderDriverKind | null {
  const payload = json(string(row, "payload_json"));
  const selection = object(payload.modelSelection ?? json(string(row, "model_selection_json")));
  const instance =
    text(payload.providerInstanceId) ??
    text(selection.instanceId) ??
    text(selection.provider) ??
    string(row, "provider_instance_id") ??
    string(row, "default_provider");
  let driver = text(payload.driver) ?? text(selection.driver);
  if (!driver && instance && SUPPORTED_DRIVERS.has(instance)) driver = instance;
  if (
    !driver &&
    has(snapshot, "orchestration_v2_projection_provider_threads", "thread_id", "driver")
  ) {
    const byInstance =
      instance !== null &&
      has(snapshot, "orchestration_v2_projection_provider_threads", "provider_instance_id");
    const found = snapshot.database
      .prepare(
        `SELECT DISTINCT driver FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? AND driver IS NOT NULL${byInstance ? " AND provider_instance_id = ?" : ""} LIMIT 2`,
      )
      .all(row.thread_id!, ...(byInstance ? [instance] : []));
    driver = found.length === 1 ? string(found[0]!, "driver") : null;
  }
  if (!driver && has(snapshot, "projection_thread_sessions", "thread_id", "provider_name")) {
    const found = snapshot.database
      .prepare("SELECT provider_name FROM projection_thread_sessions WHERE thread_id = ?")
      .get(row.thread_id!);
    const provider = found ? string(found, "provider_name") : null;
    if (provider && SUPPORTED_DRIVERS.has(provider)) driver = provider;
  }
  return driver && SUPPORTED_DRIVERS.has(driver) ? ProviderDriverKind.make(driver) : null;
}

function* metadataRows(snapshot: Snapshot) {
  const seen = new Set<string>();
  for (const table of ["orchestration_v2_projection_threads", "projection_threads"] as const) {
    if (!has(snapshot, table, "thread_id", "project_id", "title", "created_at", "updated_at"))
      continue;
    let after = "";
    while (true) {
      const rows = snapshot.database
        .prepare(
          `SELECT ${selection(snapshot, table)} FROM ${table} WHERE thread_id > ? ORDER BY thread_id LIMIT ${PAGE_SIZE}`,
        )
        .all(after);
      if (rows.length === 0) break;
      for (const row of rows) {
        const id = string(row, "thread_id")!;
        after = id;
        if (seen.has(id)) continue;
        seen.add(id);
        const project = has(snapshot, "projection_projects", "project_id", "workspace_root")
          ? snapshot.database
              .prepare(
                `SELECT ${selection(snapshot, "projection_projects")} FROM projection_projects WHERE project_id = ?`,
              )
              .get(row.project_id!)
          : undefined;
        const cwd =
          (project ? string(project, "workspace_root") : null) ?? string(row, "worktree_path");
        if (!cwd?.trim()) continue;
        yield { row, cwd, project, v2: table === "orchestration_v2_projection_threads" };
      }
    }
  }
}

export const discoverT3CodeSessions = Effect.fn("T3CodeAgentSessions.discover")(
  function* (input: Pick<AgentSessionScanInput, "exportPaths">, homeDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const defaults = ["statev2.sqlite", "state.sqlite"].map((name) =>
      path.join(homeDir, ".t3", "userdata", name),
    );
    const paths = [
      ...defaults,
      ...(input.exportPaths ?? []).filter((filePath) => /\.sqlite$/i.test(filePath)),
    ];
    const candidates = new Map<
      string,
      Omit<T3CodeSessionCandidate, "providerDriver"> & {
        readonly providerDriver: ProviderDriverKind | null;
        readonly v2: boolean;
        readonly deleted: boolean;
      }
    >();
    const reports: AgentSessionSourceReport[] = [];
    const seen = new Set<string>();
    let unsupported = false;
    for (const filePath of paths) {
      if (!path.isAbsolute(filePath)) {
        unsupported = true;
        continue;
      }
      if (!(yield* fs.exists(filePath))) continue;
      const canonical = yield* fs.realPath(filePath);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const stat = yield* fs.stat(canonical);
      if (stat.type !== "File") continue;
      const discovered = yield* Effect.acquireUseRelease(
        Effect.try(() => openSnapshot(canonical)),
        (snapshot) =>
          Effect.try(() => {
            if (
              !["orchestration_v2_projection_threads", "projection_threads"].some((table) =>
                has(
                  snapshot,
                  table as Table,
                  "thread_id",
                  "project_id",
                  "title",
                  "created_at",
                  "updated_at",
                ),
              )
            )
              return null;
            const rows = Array.from(metadataRows(snapshot));
            return rows.map(({ row, cwd, project, v2 }) => {
              const driver = historicalDriver(snapshot, row);
              const threadId = string(row, "thread_id")!;
              const payload = json(string(row, "payload_json"));
              const modelSelection = object(
                payload.modelSelection ?? json(string(row, "model_selection_json")),
              );
              const createdAt = iso(string(row, "created_at"), "1970-01-01T00:00:00.000Z");
              const updatedAt = iso(string(row, "updated_at"), createdAt);
              const sessionId =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
                  ? threadId
                  : NodeCrypto.createHash("sha256")
                      .update(encodeJson(["t3code", threadId]))
                      .digest("hex");
              return {
                source: "t3code" as const,
                providerInstanceId: ProviderInstanceId.make("t3code"),
                providerDriver: driver,
                filePath: canonical,
                databasePaths: [canonical],
                cwd,
                title: historicalTitle(row),
                ...(project && string(project, "title")
                  ? { projectTitle: string(project, "title")! }
                  : {}),
                sessionId,
                threadId,
                createdAt,
                updatedAt,
                // A WAL update need not change the main database file's stat.
                mtimeMs: Date.parse(updatedAt),
                model: text(modelSelection.model) ?? string(row, "model"),
                v2,
                deleted: string(row, "deleted_at") !== null,
              };
            });
          }),
        (snapshot) => Effect.sync(() => closeSnapshot(snapshot)),
      ).pipe(Effect.orElseSucceed(() => null));
      if (discovered === null) {
        unsupported = true;
        continue;
      }
      for (const candidate of discovered) {
        const key = candidate.sessionId;
        const previous = candidates.get(key);
        if (!previous) candidates.set(key, candidate);
        else {
          const preferred = candidate.v2 && !previous.v2 ? candidate : previous;
          candidates.set(key, {
            ...preferred,
            databasePaths: [
              ...new Set([
                preferred.filePath,
                ...previous.databasePaths,
                ...candidate.databasePaths,
              ]),
            ],
          });
        }
      }
    }
    const importable = [...candidates.values()].flatMap((candidate): T3CodeSessionCandidate[] => {
      if (candidate.deleted) return [];
      if (candidate.providerDriver === null) {
        unsupported = true;
        return [];
      }
      return [{ ...candidate, providerDriver: candidate.providerDriver }];
    });
    reports.push({
      source: "t3code",
      status: unsupported
        ? importable.length
          ? "partial"
          : "unsupported"
        : importable.length
          ? "available"
          : "unavailable",
      message: unsupported
        ? "Some T3 Code databases or historical providers could not be identified safely. Supported history can be imported as a transcript; the source is never upgraded."
        : "T3 Code history is imported as a transcript from the old .t3 data directory or selected SQLite exports. Original attachment references remain in the archive; their external files are not copied. Provider sessions and credentials are not imported.",
    });
    return { candidates: importable, reports };
  },
  Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
);

function messageQuery(snapshot: Snapshot) {
  const queries: string[] = [];
  const v2 = has(
    snapshot,
    "orchestration_v2_projection_messages",
    "message_id",
    "thread_id",
    "role",
    "created_at",
    "payload_json",
  );
  if (v2)
    queries.push(
      "SELECT message_id, role, created_at, payload_json, NULL AS text FROM orchestration_v2_projection_messages WHERE thread_id = ?",
    );
  if (
    has(
      snapshot,
      "projection_thread_messages",
      "message_id",
      "thread_id",
      "role",
      "text",
      "created_at",
    )
  ) {
    queries.push(
      `SELECT message_id, role, created_at, NULL AS payload_json, text FROM projection_thread_messages AS legacy WHERE thread_id = ?${v2 ? " AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS current WHERE current.thread_id = legacy.thread_id AND current.message_id = legacy.message_id)" : ""}`,
    );
  }
  return queries;
}

function* messages(snapshot: Snapshot, threadId: string): Generator<Row, void> {
  const queries = messageQuery(snapshot);
  if (!queries.length) return;
  const statement = snapshot.database.prepare(
    `SELECT message_id, role, created_at, payload_json, text FROM (${queries.join(" UNION ALL ")}) WHERE created_at > ? OR (created_at = ? AND message_id > ?) ORDER BY created_at, message_id LIMIT ${PAGE_SIZE}`,
  );
  let afterDate = "";
  let afterId = "";
  while (true) {
    const rows = statement.all(...queries.map(() => threadId), afterDate, afterDate, afterId);
    if (rows.length === 0) return;
    for (const row of rows) {
      afterDate = string(row, "created_at")!;
      afterId = string(row, "message_id")!;
      yield row;
    }
  }
}

function containsMessage(snapshot: Snapshot, threadId: string, messageId: string) {
  for (const table of [
    "orchestration_v2_projection_messages",
    "projection_thread_messages",
  ] as const) {
    if (
      has(snapshot, table, "thread_id", "message_id") &&
      snapshot.database
        .prepare(`SELECT 1 FROM ${table} WHERE thread_id = ? AND message_id = ? LIMIT 1`)
        .get(threadId, messageId)
    )
      return true;
  }
  return false;
}

function currentMetadata(snapshot: Snapshot, candidate: T3CodeSessionCandidate) {
  for (const table of ["orchestration_v2_projection_threads", "projection_threads"] as const) {
    if (!has(snapshot, table, "thread_id", "project_id")) continue;
    const row = snapshot.database
      .prepare(`SELECT ${selection(snapshot, table)} FROM ${table} WHERE thread_id = ?`)
      .get(candidate.threadId);
    if (!row) continue;
    const project = has(snapshot, "projection_projects", "project_id", "workspace_root")
      ? snapshot.database
          .prepare("SELECT workspace_root FROM projection_projects WHERE project_id = ?")
          .get(row.project_id!)
      : undefined;
    const cwd =
      (project ? string(project, "workspace_root") : null) ?? string(row, "worktree_path");
    const driver = historicalDriver(snapshot, row);
    if (
      cwd !== candidate.cwd ||
      driver !== candidate.providerDriver ||
      string(row, "deleted_at") !== null
    )
      break;
    const payload = json(string(row, "payload_json"));
    const modelSelection = object(
      payload.modelSelection ?? json(string(row, "model_selection_json")),
    );
    return {
      title: historicalTitle(row),
      driver,
      model: text(modelSelection.model) ?? string(row, "model"),
      createdAt: iso(string(row, "created_at"), candidate.createdAt),
      updatedAt: iso(string(row, "updated_at"), candidate.updatedAt),
    };
  }
  throw new Error("The selected T3 Code thread changed or became unavailable.");
}

function attachmentReferences(row: Row) {
  const raw = string(row, "attachments_json");
  if (raw) {
    const decoded = decodeJson(raw);
    if (Option.isNone(decoded) || !Array.isArray(decoded.value) || decoded.value.length)
      return true;
  }
  const attachments = json(string(row, "payload_json")).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

export const loadT3CodeSession = Effect.fn("T3CodeAgentSessions.load")(
  function* (candidate: T3CodeSessionCandidate) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const root = path.join(config.baseDir, "imported-history");
    yield* fs.makeDirectory(root, { recursive: true });
    const destination = yield* fs.makeTempDirectory({ directory: root, prefix: "t3code-" });
    return yield* Effect.acquireUseRelease(
      Effect.try(() => {
        const snapshots: Snapshot[] = [];
        try {
          for (const filePath of candidate.databasePaths) snapshots.push(openSnapshot(filePath));
          return snapshots;
        } catch (cause) {
          for (const snapshot of snapshots) closeSnapshot(snapshot);
          throw cause;
        }
      }),
      (snapshots) =>
        Effect.gen(function* () {
          const metadata = yield* Effect.try(() => currentMetadata(snapshots[0]!, candidate));
          const archiveFilePath = path.join(destination, "source-history.jsonl");
          const archive = yield* fs.open(archiveFilePath, { flag: "w" });
          let partial = false;
          for (const snapshot of snapshots) {
            for (const table of Object.keys(TABLES) as Table[]) {
              if (
                table === "orchestration_v2_projection_provider_threads" ||
                table === "projection_thread_sessions"
              )
                continue;
              const key =
                table === "projection_projects"
                  ? "project_id"
                  : table === "projection_thread_messages" ||
                      table === "orchestration_v2_projection_messages"
                    ? "message_id"
                    : table === "orchestration_v2_projection_turn_items"
                      ? "turn_item_id"
                      : table === "projection_thread_activities"
                        ? "activity_id"
                        : table === "orchestration_events" || table === "orchestration_v2_events"
                          ? "sequence"
                          : "thread_id";
              if (!has(snapshot, table, key)) continue;
              let predicate = "thread_id = ?";
              let argument = candidate.threadId;
              if (table === "projection_projects") {
                const threadTable = has(
                  snapshot,
                  "orchestration_v2_projection_threads",
                  "thread_id",
                  "project_id",
                )
                  ? "orchestration_v2_projection_threads"
                  : "projection_threads";
                if (!has(snapshot, threadTable, "thread_id", "project_id")) continue;
                const row = yield* Effect.try(() =>
                  snapshot.database
                    .prepare(`SELECT project_id FROM ${threadTable} WHERE thread_id = ?`)
                    .get(candidate.threadId),
                );
                argument = row ? (string(row, "project_id") ?? "") : "";
                predicate = "project_id = ?";
              } else if (table === "orchestration_events") {
                if (!has(snapshot, table, "aggregate_kind", "stream_id")) continue;
                predicate = "aggregate_kind = 'thread' AND stream_id = ?";
              } else if (!has(snapshot, table, "thread_id")) continue;
              const statement = yield* Effect.try(() =>
                snapshot.database.prepare(
                  `SELECT ${selection(snapshot, table)} FROM ${table} WHERE ${predicate} AND ${key} > ? ORDER BY ${key} LIMIT ${PAGE_SIZE}`,
                ),
              );
              let after: string | number = key === "sequence" ? -1 : "";
              while (true) {
                const rows = yield* Effect.try(() => statement.all(argument, after));
                if (!rows.length) break;
                for (const row of rows) {
                  const keyValue = row[key];
                  if (typeof keyValue === "string" || typeof keyValue === "number")
                    after = keyValue;
                  if (
                    table === "projection_thread_messages" ||
                    table === "orchestration_v2_projection_messages"
                  )
                    partial ||= attachmentReferences(row);
                  yield* archive.writeAll(
                    new TextEncoder().encode(
                      encodeJson({
                        sourceDatabase: path.basename(snapshot.filePath),
                        table,
                        row,
                      }) + "\n",
                    ),
                  );
                }
              }
            }
          }
          const iterators = snapshots.map((snapshot) => messages(snapshot, candidate.threadId));
          const next = yield* Effect.try(() => iterators.map((iterator) => iterator.next()));
          const projectionFiles: string[] = [];
          let page: AgentSessionThreadMessage[] = [];
          let messageCount = 0;
          const flush = Effect.fn("T3CodeAgentSessions.flushMessages")(function* () {
            if (!page.length) return;
            const filePath = path.join(destination, `messages-${projectionFiles.length}.json`);
            yield* fs.writeFileString(filePath, encodeJson(page));
            projectionFiles.push(filePath);
            page = [];
          });
          while (true) {
            let selected = -1;
            for (let index = 0; index < next.length; index++) {
              const current = next[index];
              if (current?.done !== false) continue;
              const previous = next[selected];
              if (
                !previous ||
                previous.done ||
                `${current.value.created_at}\0${current.value.message_id}` <
                  `${previous.value.created_at}\0${previous.value.message_id}`
              )
                selected = index;
            }
            if (selected === -1) break;
            const result = next[selected]!;
            if (result.done) break;
            const row = result.value;
            const duplicate = yield* Effect.try(() =>
              snapshots
                .slice(0, selected)
                .some((snapshot) =>
                  containsMessage(snapshot, candidate.threadId, string(row, "message_id")!),
                ),
            );
            if (!duplicate && (row.role === "user" || row.role === "assistant")) {
              const payload = json(string(row, "payload_json"));
              const body =
                string(row, "text") ?? (typeof payload.text === "string" ? payload.text : null);
              if (body === null) partial = true;
              else {
                page.push({
                  role: row.role,
                  text: body,
                  createdAt: iso(string(row, "created_at"), candidate.createdAt),
                });
                messageCount++;
                if (page.length === PAGE_SIZE) yield* flush();
              }
            }
            next[selected] = yield* Effect.try(() => iterators[selected]!.next());
          }
          yield* flush();
          const thread: AgentSessionThread = {
            source: "t3code",
            providerInstanceId: ProviderInstanceId.make(metadata.driver),
            providerDriver: metadata.driver,
            providerSessionId: candidate.sessionId,
            title: metadata.title,
            model: metadata.model,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            messages: [],
            projectionFiles,
            messageCount,
            nativeContinuation: false,
            partial,
          };
          return { thread, archiveFilePath };
        }).pipe(Effect.scoped),
      (snapshots) =>
        Effect.sync(() => {
          for (const snapshot of snapshots) closeSnapshot(snapshot);
        }),
    ).pipe(Effect.onError(() => fs.remove(destination, { recursive: true }).pipe(Effect.orDie)));
  },
  Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
);
