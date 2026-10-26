import {
  ProviderInstanceId,
  type AgentSessionScanInput,
  type AgentSessionSourceReport,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";
import type { AgentSessionThread, AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const TextPart = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
const ExportMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TextPart)])),
  timestamp: Schema.optional(Schema.String),
  info: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      modelID: Schema.optional(Schema.String),
      time: Schema.optional(Schema.Struct({ created: Schema.optional(Schema.Number) })),
    }),
  ),
  parts: Schema.optional(Schema.Array(TextPart)),
});
const ExportData = Schema.Struct({
  provider: Schema.optional(Schema.Literals(["antigravity", "opencode"])),
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  info: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      title: Schema.optional(Schema.String),
      directory: Schema.String,
      time: Schema.optional(
        Schema.Struct({
          created: Schema.optional(Schema.Number),
          updated: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
  messages: Schema.optional(Schema.Array(ExportMessage)),
  replay: Schema.optional(
    Schema.Array(
      Schema.Struct({
        sessionUpdate: Schema.String,
        content: Schema.optional(TextPart),
      }),
    ),
  ),
});
const ExportMetadata = Schema.Struct({
  provider: Schema.optional(Schema.Literals(["antigravity", "opencode"])),
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  info: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      directory: Schema.String,
      title: Schema.optional(Schema.String),
    }),
  ),
});
const decodeMetadata = Schema.decodeUnknownOption(ExportMetadata);
const selectMetadata = createTranscriptJsonSelector(ExportMetadata);
const decodeExport = Schema.decodeUnknownOption(ExportData);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Unknown }));
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodePart = Schema.decodeUnknownOption(TextPart);
const decodeMessage = Schema.decodeUnknownOption(ExportMessage);

export interface ExternalSessionCandidate {
  readonly source: "opencode" | "antigravity";
  readonly providerInstanceId: ProviderInstanceId;
  readonly filePath: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly mtimeMs: number;
  readonly format: "export" | "opencode-sqlite";
}

const iso = (value: number, fallback: number) =>
  DateTime.formatIso(
    DateTime.makeUnsafe(Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : fallback),
  );

export function parseExternalSessionExport(contents: string, fallbackMs: number) {
  const json = decodeJson(contents);
  if (Option.isNone(json)) return null;
  const envelope = decodeEnvelope(json.value);
  const decoded = decodeExport(Option.isSome(envelope) ? envelope.value.data : json.value);
  if (Option.isNone(decoded)) return null;
  const data = decoded.value;
  const source = data.provider === "antigravity" ? "antigravity" : "opencode";
  const sessionId = data.info?.id ?? data.sessionId;
  const cwd = data.info?.directory ?? data.cwd;
  if (!sessionId?.trim() || !cwd?.trim()) return null;
  let partial = false;
  const entries: Array<typeof ExportMessage.Type> = [...(data.messages ?? [])];
  if (source === "antigravity" && data.replay) {
    for (const update of data.replay) {
      const role =
        update.sessionUpdate === "user_message_chunk"
          ? "user"
          : update.sessionUpdate === "agent_message_chunk"
            ? "assistant"
            : null;
      if (role === null || update.content?.type !== "text") {
        partial = true;
        continue;
      }
      const last = entries.at(-1);
      if (last?.role === role)
        entries[entries.length - 1] = {
          ...last,
          text: (last.text ?? "") + (update.content.text ?? ""),
        };
      else entries.push({ role, text: update.content.text ?? "" });
    }
  }
  const messages: AgentSessionThreadMessage[] = entries.flatMap(
    (entry): AgentSessionThreadMessage[] => {
      const role = entry.info?.role ?? entry.role;
      if (role !== "user" && role !== "assistant") {
        partial = true;
        return [];
      }
      const parts = entry.parts ?? (Array.isArray(entry.content) ? entry.content : []);
      if (
        parts.some(
          (part) =>
            part.type !== "text" && part.type !== "input_text" && part.type !== "output_text",
        )
      )
        partial = true;
      const text =
        entry.text ??
        (typeof entry.content === "string"
          ? entry.content
          : parts
              .filter(
                (part) =>
                  part.type === "text" || part.type === "input_text" || part.type === "output_text",
              )
              .map((part) => part.text ?? "")
              .join("\n"));
      if (!text.trim()) return [];
      return [
        {
          role,
          text,
          createdAt: iso(
            entry.info?.time?.created ?? Date.parse(entry.timestamp ?? ""),
            fallbackMs,
          ),
        },
      ];
    },
  );
  if (messages.length === 0) return null;
  return {
    cwd,
    thread: {
      source,
      providerInstanceId: ProviderInstanceId.make(source),
      providerSessionId: sessionId,
      title: data.info?.title ?? data.title ?? messages[0]!.text.slice(0, 100),
      model: entries.findLast((entry) => entry.info?.modelID)?.info?.modelID ?? null,
      createdAt: messages[0]!.createdAt,
      updatedAt: iso(data.info?.time?.updated ?? fallbackMs, fallbackMs),
      messages,
      nativeContinuation: false,
      partial,
    } satisfies AgentSessionThread,
  };
}

const readExport = Effect.fn("ExternalAgentSessions.readExport")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(filePath);
  if (stat.type !== "File") return null;
  const mtimeMs = Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0;
  if (Number(stat.size) > MAX_EXPORT_BYTES) {
    let selectedBytes = 0;
    const reader = createTranscriptJsonReader((bytes) => {
      selectedBytes += bytes;
      if (selectedBytes > MAX_EXPORT_BYTES)
        throw new TranscriptJsonLimitError("Export metadata is too large");
    }, selectMetadata);
    const decoder = new TextDecoder();
    yield* fs
      .stream(filePath, { chunkSize: 32 * 1024 })
      .pipe(
        Stream.runForEach((bytes) =>
          Effect.try(() => reader.write(decoder.decode(bytes, { stream: true }))),
        ),
      );
    const value = yield* Effect.try(() => {
      reader.write(decoder.decode());
      return decodeMetadata(reader.finish());
    });
    if (Option.isNone(value)) return null;
    const sessionId = value.value.info?.id ?? value.value.sessionId;
    const cwd = value.value.info?.directory ?? value.value.cwd;
    if (!sessionId || !cwd) return null;
    const source = value.value.provider === "antigravity" ? "antigravity" : "opencode";
    return {
      cwd,
      mtimeMs,
      thread: {
        source,
        providerInstanceId: ProviderInstanceId.make(source),
        providerSessionId: sessionId,
        title: value.value.info?.title ?? value.value.title ?? "Imported archive",
        model: null,
        createdAt: iso(mtimeMs, 0),
        updatedAt: iso(mtimeMs, 0),
        messages: [],
        nativeContinuation: false,
        partial: true,
      } satisfies AgentSessionThread,
    };
  }
  const parsed = parseExternalSessionExport(yield* fs.readFileString(filePath), mtimeMs);
  return parsed === null ? null : { ...parsed, mtimeMs };
});

const sqliteSchema = Effect.fn("ExternalAgentSessions.sqliteSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql.unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )).map((row) => row.name),
  );
  if (!tables.has("session") || !tables.has("message") || !tables.has("part")) return false;
  for (const [table, required] of [
    ["session", ["id", "directory", "title", "time_created", "time_updated"]],
    ["message", ["id", "session_id", "data"]],
    ["part", ["id", "message_id", "data"]],
  ] as const) {
    const columns = new Set(
      (yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name),
    );
    if (required.some((name) => !columns.has(name))) return false;
  }
  return true;
});

const readSqliteSessions = Effect.fn("ExternalAgentSessions.readSqliteSessions")(function* (
  filePath: string,
  providerInstanceId: ProviderInstanceId,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* sqliteSchema())) return null;
  const rows = yield* sql.unsafe<{ id: string; directory: string; time_updated: number }>(
    "SELECT id, directory, time_updated FROM session ORDER BY id",
  );
  return rows.map((row): ExternalSessionCandidate => ({
    source: "opencode",
    providerInstanceId,
    filePath,
    cwd: row.directory,
    sessionId: row.id,
    mtimeMs: row.time_updated,
    format: "opencode-sqlite",
  }));
});

export const discoverExternalSessions = Effect.fn("ExternalAgentSessions.discover")(function* (
  input: AgentSessionScanInput,
  roots: ReadonlyArray<{ path: string; providerInstanceId: ProviderInstanceId }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: ExternalSessionCandidate[] = [];
  const reports: AgentSessionSourceReport[] = [];
  const selected = new Set(input.sources ?? ["codex", "claudeAgent", "opencode", "antigravity"]);
  const seen = new Set<string>();
  for (const exportPath of input.exportPaths ?? []) {
    if (!path.isAbsolute(exportPath)) {
      reports.push({
        source: "opencode",
        status: "failed",
        message: "Export paths must be absolute paths on the selected computer.",
      });
      continue;
    }
    const parsed = yield* readExport(exportPath).pipe(Effect.orElseSucceed(() => null));
    if (parsed === null) {
      reports.push({
        source: "antigravity",
        status: "unsupported",
        message: `Could not read ${path.basename(exportPath)} as an OpenCode or Antigravity transcript export.`,
      });
      continue;
    }
    if (!selected.has(parsed.thread.source)) continue;
    candidates.push({
      source: parsed.thread.source as "opencode" | "antigravity",
      providerInstanceId: parsed.thread.providerInstanceId,
      filePath: exportPath,
      cwd: parsed.cwd,
      sessionId: parsed.thread.providerSessionId,
      mtimeMs: parsed.mtimeMs,
      format: "export",
    });
  }
  if (selected.has("opencode")) {
    for (const root of roots) {
      const names = yield* fs
        .readDirectory(root.path)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const name of names.filter((entry) =>
        /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry),
      )) {
        const filePath = path.join(root.path, name);
        const canonical = yield* fs.realPath(filePath).pipe(Effect.orElseSucceed(() => filePath));
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const sessions = yield* readSqliteSessions(filePath, root.providerInstanceId).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: filePath, readonly: true })),
          Effect.orElseSucceed(() => null),
        );
        if (sessions === null)
          reports.push({
            source: "opencode",
            status: "unsupported",
            message:
              "This OpenCode database format could not be read safely. Export sessions with the installed OpenCode version; mines never upgrades or converts its database.",
          });
        else candidates.push(...sessions);
      }
    }
    reports.push({
      source: "opencode",
      status: candidates.some((candidate) => candidate.source === "opencode")
        ? "available"
        : "unavailable",
      message:
        "OpenCode SQLite history and JSON exports are supported. Native v2 and legacy JSON stores can be imported through the installed version's session export command.",
    });
  }
  if (selected.has("antigravity"))
    reports.push({
      source: "antigravity",
      status: candidates.some((candidate) => candidate.source === "antigravity")
        ? "partial"
        : "unsupported",
      message:
        "Antigravity transcript exports are supported. Native IDE, CLI, and ACP stores are not universally readable; unavailable history is not reported as imported.",
    });
  return { candidates, reports };
});

export const loadExternalSession = Effect.fn("ExternalAgentSessions.load")(function* (
  candidate: ExternalSessionCandidate,
) {
  if (candidate.format === "export") {
    const parsed = yield* readExport(candidate.filePath);
    return parsed?.cwd === candidate.cwd && parsed.thread.providerSessionId === candidate.sessionId
      ? parsed.thread
      : null;
  }
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* sqliteSchema())) return null;
    const [session] = yield* sql.unsafe<{
      id: string;
      directory: string;
      title: string;
      time_created: number;
      time_updated: number;
    }>("SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?", [
      candidate.sessionId,
    ]);
    if (!session || session.directory !== candidate.cwd) return null;
    const archiveOnly = (): AgentSessionThread => ({
      source: "opencode",
      providerInstanceId: candidate.providerInstanceId,
      providerSessionId: session.id,
      title: session.title,
      model: null,
      createdAt: iso(session.time_created, candidate.mtimeMs),
      updatedAt: iso(session.time_updated, candidate.mtimeMs),
      messages: [],
      nativeContinuation: true,
      partial: true,
    });
    const messages: Array<typeof ExportMessage.Type> = [];
    let bytes = 0;
    let after = "";
    let partial = false;
    while (true) {
      const rows = yield* sql.unsafe<{ id: string; data: string }>(
        "SELECT id, data FROM message WHERE session_id = ? AND id > ? ORDER BY id LIMIT 64",
        [candidate.sessionId, after],
      );
      for (const row of rows) {
        bytes += Buffer.byteLength(row.data);
        if (bytes > MAX_EXPORT_BYTES) return archiveOnly();
        const json = decodeJson(row.data);
        const info = Option.isSome(json) ? decodeObject(json.value) : Option.none();
        if (Option.isNone(info)) {
          partial = true;
          continue;
        }
        const rawParts = yield* sql.unsafe<{ data: string }>(
          "SELECT data FROM part WHERE message_id = ? ORDER BY id",
          [row.id],
        );
        const parts: Array<typeof TextPart.Type> = [];
        for (const rowPart of rawParts) {
          bytes += Buffer.byteLength(rowPart.data);
          if (bytes > MAX_EXPORT_BYTES) return archiveOnly();
          const partJson = decodeJson(rowPart.data);
          const part = Option.isSome(partJson) ? decodePart(partJson.value) : Option.none();
          if (Option.isSome(part)) parts.push(part.value);
          else partial = true;
        }
        const decoded = decodeMessage({ info: info.value, parts });
        if (Option.isSome(decoded)) messages.push(decoded.value);
        else partial = true;
      }
      if (rows.length < 64) break;
      after = rows[rows.length - 1]!.id;
    }
    const parsed = parseExternalSessionExport(
      encodeJson({
        info: {
          id: session.id,
          directory: session.directory,
          title: session.title,
          time: { created: session.time_created, updated: session.time_updated },
        },
        messages,
      }),
      candidate.mtimeMs,
    );
    return parsed === null
      ? null
      : {
          ...parsed.thread,
          providerInstanceId: candidate.providerInstanceId,
          nativeContinuation: true,
          partial: partial || parsed.thread.partial,
        };
  }).pipe(
    NodeSqliteClient.readOnly,
    Effect.provide(NodeSqliteClient.layer({ filename: candidate.filePath, readonly: true })),
  );
});

/** A dedicated readonly transaction keeps paged archive reads on one source snapshot. */
export const externalSessionArchive = (candidate: ExternalSessionCandidate) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const connection = yield* sql.reserve;
      yield* Effect.acquireRelease(connection.executeUnprepared("BEGIN", [], undefined), () =>
        connection.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.orDie),
      );
      const queries = [
        "SELECT 'session' AS kind, id, json_object('id', id, 'directory', directory, 'title', title, 'time_created', time_created, 'time_updated', time_updated) AS data FROM session WHERE id = ? AND id > ? ORDER BY id LIMIT 64",
        "SELECT 'message' AS kind, id, data FROM message WHERE session_id = ? AND id > ? ORDER BY id LIMIT 64",
        "SELECT 'part' AS kind, p.id, p.data FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = ? AND p.id > ? ORDER BY p.id LIMIT 64",
      ];
      return Stream.fromIterable(queries).pipe(
        Stream.flatMap((query) =>
          Stream.paginate("", (after) =>
            connection
              .execute(query, [candidate.sessionId, after], undefined)
              .pipe(
                Effect.map(
                  (rows) =>
                    [
                      rows,
                      rows.length === 64
                        ? Option.some(String(rows[rows.length - 1]!.id))
                        : Option.none<string>(),
                    ] as const,
                ),
              ),
          ),
        ),
        Stream.map((record) => new TextEncoder().encode(`${encodeJson(record)}\n`)),
      );
    }),
  ).pipe(Stream.provide(NodeSqliteClient.layer({ filename: candidate.filePath, readonly: true })));
