import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  discoverExternalSessions,
  loadExternalSession,
  externalSessionArchive,
  parseExternalSessionExport,
} from "./ExternalAgentSessions.ts";

const exported = (messages: ReadonlyArray<unknown>) =>
  JSON.stringify({
    info: { id: "ses_fixture", directory: "/fixture/project", title: "Retained history" },
    messages,
  });

describe("external history imports", () => {
  it("keeps every retained exported message and marks non-text records partial", () => {
    const messages = Array.from({ length: 251 }, (_, index) => ({
      info: { role: index % 2 ? "assistant" : "user" },
      parts: [{ type: "text", text: `message ${index}` }],
    }));
    const parsed = parseExternalSessionExport(
      exported([
        ...messages,
        { info: { role: "assistant" }, parts: [{ type: "tool", text: "source only" }] },
      ]),
      0,
    );
    expect(parsed?.thread.messages).toHaveLength(251);
    expect(parsed?.thread).toMatchObject({ nativeContinuation: false, partial: true });
  });

  it("imports Antigravity ACP replay text as a transcript without inventing native continuation", () => {
    const parsed = parseExternalSessionExport(
      JSON.stringify({
        provider: "antigravity",
        sessionId: "replay-1",
        cwd: "/fixture/project",
        replay: [
          { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Good " } },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "morning" } },
          { sessionUpdate: "tool_call", toolCallId: "fixture-tool" },
        ],
      }),
      0,
    );
    expect(parsed?.thread.messages.map(({ text }) => text)).toEqual(["Hello", "Good morning"]);
    expect(parsed?.thread).toMatchObject({
      source: "antigravity",
      nativeContinuation: false,
      partial: true,
    });
  });

  it("does not claim an unreadable or empty native archive is imported", () => {
    expect(parseExternalSessionExport("not json", 0)).toBeNull();
    expect(parseExternalSessionExport(exported([]), 0)).toBeNull();
    expect(
      parseExternalSessionExport(
        JSON.stringify({ messages: [{ role: "user", text: "missing source identity" }] }),
        0,
      ),
    ).toBeNull();
  });

  it.effect(
    "archives one SQLite session across pages from a consistent readonly snapshot without a CLI",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const db = path.join(root, "opencode.db");
        const missingWorkspace = path.join(root, "deleted", "workspace");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL");
          yield* sql.unsafe(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
          );
          yield* sql.unsafe(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
          );
          yield* sql.unsafe("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)");
          yield* sql.unsafe(
            "INSERT INTO session VALUES ('selected', ?, 'Retained', 0, 1), ('other', '/other', 'Other', 0, 1)",
            [missingWorkspace],
          );
          for (let index = 0; index < 70; index++) {
            const id = `msg_${String(index).padStart(3, "0")}`;
            yield* sql.unsafe("INSERT INTO message VALUES (?, 'selected', ?)", [
              id,
              JSON.stringify({ role: "user", text: `message ${index}` }),
            ]);
            yield* sql.unsafe("INSERT INTO part VALUES (?, ?, ?)", [
              `part_${index}`,
              id,
              JSON.stringify({ type: "tool", reference: `file_${index}` }),
            ]);
          }
          yield* sql.unsafe("INSERT INTO message VALUES ('other_message', 'other', '{}')");
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: db })));
        const records: Array<{ kind: string; id: string; data: string }> = [];
        yield* externalSessionArchive({
          source: "opencode",
          providerInstanceId: ProviderInstanceId.make("opencode"),
          filePath: db,
          cwd: missingWorkspace,
          sessionId: "selected",
          mtimeMs: 1,
          format: "opencode-sqlite",
        }).pipe(
          Stream.runForEach((bytes) =>
            Effect.gen(function* () {
              const record = JSON.parse(
                new TextDecoder().decode(bytes),
              ) as (typeof records)[number];
              records.push(record);
              if (record.kind === "session")
                yield* Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe(
                    "INSERT INTO message VALUES ('later_message', 'selected', '{}')",
                  );
                }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: db })));
            }),
          ),
        );
        expect(records.filter((record) => record.kind === "message")).toHaveLength(70);
        expect(records.filter((record) => record.kind === "part")).toHaveLength(70);
        expect(
          records.some((record) => record.id === "later_message" || record.id === "other_message"),
        ).toBe(false);
        expect(yield* fs.exists(missingWorkspace)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads all SQLite sessions without changing their database and rejects unknown schemas",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const db = path.join(root, "opencode.db");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)",
          );
          yield* sql.unsafe(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)",
          );
          yield* sql.unsafe("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)");
          yield* sql.unsafe(
            "INSERT INTO session VALUES ('ses_old', '/fixture/project', 'Old archive', 0, 1, 2)",
          );
          yield* sql.unsafe("INSERT INTO message VALUES ('msg_1', 'ses_old', ?)", [
            JSON.stringify({ role: "user", time: { created: 0 } }),
          ]);
          yield* sql.unsafe("INSERT INTO part VALUES ('prt_1', 'msg_1', ?)", [
            JSON.stringify({ type: "text", text: "Retained archived message" }),
          ]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: db })));
        const before = yield* fs.readFile(db);
        const found = yield* discoverExternalSessions({ sources: ["opencode", "antigravity"] }, [
          { path: root, providerInstanceId: ProviderInstanceId.make("opencode-test") },
        ]);
        expect(found.candidates).toHaveLength(1);
        expect(found.reports).toContainEqual(
          expect.objectContaining({ source: "antigravity", status: "unsupported" }),
        );
        const thread = yield* loadExternalSession(found.candidates[0]!);
        expect(thread).toMatchObject({ providerSessionId: "ses_old", nativeContinuation: true });
        expect(thread?.messages[0]?.text).toBe("Retained archived message");
        const archive = yield* externalSessionArchive(found.candidates[0]!).pipe(Stream.runCollect);
        const records = archive.flatMap((bytes) =>
          new TextDecoder()
            .decode(bytes)
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { kind: string; id: string }),
        );
        expect(records.map(({ kind, id }) => [kind, id])).toEqual([
          ["session", "ses_old"],
          ["message", "msg_1"],
          ["part", "prt_1"],
        ]);
        expect(yield* fs.readFile(db)).toEqual(before);
        const unsupportedRoot = yield* fs.makeTempDirectoryScoped();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("CREATE TABLE event (id TEXT)");
        }).pipe(
          Effect.provide(
            NodeSqliteClient.layer({ filename: path.join(unsupportedRoot, "opencode.db") }),
          ),
        );
        const unsupported = yield* discoverExternalSessions({ sources: ["opencode"] }, [
          { path: unsupportedRoot, providerInstanceId: ProviderInstanceId.make("opencode") },
        ]);
        expect(unsupported.candidates).toEqual([]);
        expect(unsupported.reports).toContainEqual(
          expect.objectContaining({ status: "unsupported" }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
