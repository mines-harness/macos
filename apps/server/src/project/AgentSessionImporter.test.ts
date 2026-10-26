import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  AgentSessionScanError,
  ChatAttachmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type AgentSessionSourceSection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: "codex" | "claudeAgent" = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({
      driver,
      nativeThreadId: providerSessionId,
    }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: providerSessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  messageStream?: (
    thread: AgentSessionScanner.AgentSessionThread,
  ) => Stream.Stream<AgentSessionScanner.AgentSessionThreadMessage, AgentSessionScanError>,
  sourceSection?: AgentSessionSourceSection,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const dispatched: OrchestrationV2ServerCommand[] = [];
  let requestedTitleRepairs: ReadonlyArray<ThreadId> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: (_root, _completed, _input, titleRepairThreadIds) => {
              requestedTitleRepairs = titleRepairThreadIds ?? [];
              return Stream.fromIterable(candidates);
            },
            projectSourceSection: () => Effect.succeed(sourceSection),
            streamMessages: messageStream ?? ((thread) => Stream.fromIterable(thread.messages)),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 0, storedEvents: [] };
              }),
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    published,
    dispatched,
    requestedTitleRepairs: () => requestedTitleRepairs,
  };
});

it.effect("repairs only generated Codex context titles when retained history is refreshed", () =>
  Effect.gen(function* () {
    const placeholder =
      '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
    const broken = candidate(CODEX_MODEL_SELECTION, "bad-context-title");
    const renamed = candidate(CODEX_MODEL_SELECTION, "custom-title");
    const initial = yield* makeImporter([
      { ...broken, thread: { ...broken.thread, title: placeholder } },
      { ...renamed, thread: { ...renamed.thread, title: "My chosen title" } },
    ]);
    yield* initial.run;
    const refresh = yield* makeImporter([
      {
        _tag: "AlreadyImported",
        source: broken.source,
        title: "Actual native title",
        nativeTitle: "Actual native title",
      },
      {
        _tag: "AlreadyImported",
        source: renamed.source,
        title: "A different source title",
        nativeTitle: "A different source title",
      },
    ]);
    expect((yield* refresh.run).catalogThreads).toEqual([
      { threadId: importId(broken), title: "Actual native title" },
    ]);
    expect(refresh.requestedTitleRepairs()).toEqual([importId(broken)]);
    expect(refresh.dispatched).toMatchObject([
      {
        type: "thread.metadata.update",
        threadId: importId(broken),
        title: "Actual native title",
        expectedTitle: placeholder,
      },
    ]);
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "returns project sections when all threads were already imported or none were selected",
  () =>
    Effect.gen(function* () {
      const sourceSection = { id: "native-project-section", title: "Studio" };
      const source = candidate(CODEX_MODEL_SELECTION, "project-section-refresh");
      yield* (yield* makeImporter([source])).run;
      for (const outcomes of [[], [{ _tag: "AlreadyImported" as const, source: source.source }]]) {
        const importer = yield* makeImporter(outcomes, Effect.void, undefined, sourceSection);
        expect((yield* importer.run).sourceSection).toEqual(sourceSection);
        expect(importer.dispatched).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("returns native section placements only for successfully retained imports", () =>
  Effect.gen(function* () {
    const sourceSection = { id: "native-section", title: "Studio", order: 2 };
    const source = candidate(CODEX_MODEL_SELECTION, "with-section");
    const owned = candidate(CODEX_MODEL_SELECTION, "owned-with-section");
    yield* seedOwner(owned);
    const importer = yield* makeImporter([
      { ...source, thread: { ...source.thread, sourceSection } },
      { ...owned, thread: { ...owned.thread, sourceSection } },
    ]);
    expect((yield* importer.run).catalogThreads).toEqual([
      { threadId: importId(source), title: source.thread.title, sourceSection },
    ]);
    const retained = yield* makeImporter([
      {
        _tag: "AlreadyImported",
        source: source.source,
        title: "Native renamed title",
        nativeTitle: "Native renamed title",
        sourceSection,
      },
    ]);
    expect((yield* retained.run).catalogThreads).toEqual([
      { threadId: importId(source), title: source.thread.title, sourceSection },
    ]);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect((yield* projections.getThreadRecords(importId(source), [])).thread.title).toBe(
      source.thread.title,
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports native history without scheduling a provider session or turn", () =>
  Effect.gen(function* () {
    const importedAt = "2026-10-26T09:00:00.000Z";
    yield* TestClock.setTime(Date.parse(importedAt));
    const source = candidate(CODEX_MODEL_SELECTION, "history-only");
    const archiveAttachments = [
      {
        type: "file" as const,
        id: ChatAttachmentId.make("history-archive"),
        name: "source-history-manifest.json",
        mimeType: "application/json",
        sizeBytes: 123,
      },
    ];
    const importer = yield* makeImporter([
      {
        ...source,
        thread: { ...source.thread, nativeContinuation: true, archiveAttachments },
      },
    ]);
    expect(yield* importer.run).toMatchObject({ importedCount: 1 });
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const records = yield* projections.getThreadRecords(importId(source), [
      "providerThreads",
      "runs",
      "messages",
    ]);
    expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
    expect(records.thread).toMatchObject({
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
    });
    expect(records.thread.importArchiveAttachments).toEqual(archiveAttachments);
    expect(DateTime.formatIso(records.thread.importedAt!)).toBe(importedAt);
    expect(
      DateTime.formatIso((yield* projections.getThreadShell(importId(source)))!.importedAt!),
    ).toBe(importedAt);
    yield* TestClock.setTime(Date.parse("2026-10-27T09:00:00.000Z"));
    yield* importer.run;
    expect(
      DateTime.formatIso(
        (yield* projections.getThreadRecords(importId(source), [])).thread.importedAt!,
      ),
    ).toBe(importedAt);
    expect(records.runs).toEqual([]);
    expect(records.providerThreads).toMatchObject([{ status: "idle", lastRunOrdinal: null }]);
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importId(source) })),
    ).toMatchObject({
      status: "stopped",
      runtimePayload: { importArchiveAttachments: archiveAttachments },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retains a projectless native parent and its subagent lineage without provider work",
  () =>
    Effect.gen(function* () {
      const parent = candidate(CODEX_MODEL_SELECTION, "native-parent");
      const children = ["cloudflare", "supplier", "images", "commerce"].map((name) => {
        const child = candidate(CODEX_MODEL_SELECTION, `native-${name}`);
        return {
          ...child,
          thread: {
            ...child.thread,
            sourceThreadId: child.thread.providerSessionId,
            sourceParentThreadId: parent.thread.providerSessionId,
            sourceRootThreadId: parent.thread.providerSessionId,
            kind: "subagent" as const,
            agentName: name,
            sourceProject: null,
          },
        };
      });
      const grandchild = candidate(CODEX_MODEL_SELECTION, "native-grandchild");
      const importer = yield* makeImporter([
        ...children,
        {
          ...grandchild,
          thread: {
            ...grandchild.thread,
            sourceThreadId: grandchild.thread.providerSessionId,
            sourceParentThreadId: children[0]!.thread.providerSessionId,
            sourceRootThreadId: parent.thread.providerSessionId,
            kind: "subagent",
            sourceProject: null,
          },
        },
        {
          ...parent,
          thread: {
            ...parent.thread,
            sourceThreadId: parent.thread.providerSessionId,
            kind: "thread",
            sourceProject: null,
          },
        },
      ]);
      const result = yield* importer.run;
      expect(result.importedCount).toBe(6);
      expect(result.catalogThreads).toHaveLength(6);
      expect(result.catalogThreads?.[0]).toMatchObject({
        threadId: importId(children[0]!),
        sourceThreadId: "native-cloudflare",
        sourceParentThreadId: "native-parent",
        sourceRootThreadId: "native-parent",
        kind: "subagent",
        sourceProject: null,
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const child of children) {
        const records = yield* projections.getThreadRecords(importId(child), ["messages", "runs"]);
        expect(records.thread).toMatchObject({
          creationSource: "provider",
          lineage: {
            parentThreadId: importId(parent),
            relationshipToParent: "subagent",
            rootThreadId: importId(parent),
          },
        });
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.runs).toEqual([]);
      }
      expect(
        (yield* projections.getThreadRecords(importId(grandchild), [])).thread.lineage,
      ).toEqual({
        parentThreadId: importId(children[0]!),
        relationshipToParent: "subagent",
        rootThreadId: importId(parent),
      });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
      expect(importer.dispatched).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "refreshes existing native child lineage and returns projectless catalog provenance",
  () =>
    Effect.gen(function* () {
      const old = candidate(CODEX_MODEL_SELECTION, "already-imported-child");
      yield* (yield* makeImporter([
        { ...old, thread: { ...old.thread, title: "My retained title" } },
      ])).run;
      const refresh = yield* makeImporter([
        {
          _tag: "AlreadyImported",
          source: old.source,
          title: "Source title",
          sourceThreadId: "already-imported-child",
          sourceParentThreadId: "native-parent",
          sourceRootThreadId: "native-root",
          kind: "subagent",
          agentName: "Research",
          sourceProject: null,
        },
      ]);
      const result = yield* refresh.run;
      expect(result.catalogThreads).toMatchObject([
        {
          threadId: importId(old),
          title: "My retained title",
          sourceThreadId: "already-imported-child",
          kind: "subagent",
          sourceProject: null,
          parentThreadId: "import:codex:native-parent",
          rootThreadId: "import:codex:native-root",
        },
      ]);
      expect(refresh.dispatched).toMatchObject([
        {
          type: "thread.metadata.update",
          threadId: importId(old),
          expectedLineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: importId(old),
          },
          importedLineage: {
            parentThreadId: "import:codex:native-parent",
            relationshipToParent: "subagent",
            rootThreadId: "import:codex:native-root",
          },
        },
      ]);
      expect(refresh.dispatched[0]).not.toHaveProperty("title");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const current = yield* projections.getThreadRecords(importId(old), ["messages", "runs"]);
      expect(current.thread.title).toBe("My retained title");
      expect(current.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
      expect(current.runs).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "refreshes only proven old automatic settlement and preserves manual settlement stamps",
  () =>
    Effect.gen(function* () {
      const automatic = candidate(CODEX_MODEL_SELECTION, "old-automatic-settlement");
      const manual = candidate(CODEX_MODEL_SELECTION, "manual-settlement");
      yield* (yield* makeImporter([automatic, manual])).run;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      for (const source of [automatic, manual]) {
        const threadId = importId(source);
        const thread = (yield* projections.getThreadRecords(threadId, [])).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`seed-old-settlement:${threadId}`),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: {
                ...thread,
                settledOverride: "settled",
                settledAt:
                  source === automatic ? now : DateTime.makeUnsafe("2026-10-01T10:00:00.000Z"),
                unsettledAt: null,
              },
            },
          ],
        });
      }
      const refresh = yield* makeImporter([
        { _tag: "AlreadyImported", source: automatic.source },
        { _tag: "AlreadyImported", source: manual.source },
      ]);
      yield* refresh.run;
      expect(refresh.dispatched).toHaveLength(1);
      expect(refresh.dispatched[0]).toMatchObject({
        type: "thread.metadata.update",
        threadId: importId(automatic),
      });
      const command = refresh.dispatched[0];
      if (command?.type !== "thread.metadata.update")
        throw new Error("Expected import metadata repair");
      expect(DateTime.formatIso(command.clearImportedSettlement!)).toBe(timestamp);
      expect(command).not.toHaveProperty("title");
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "repairs imported server auto-settlement from its authoritative event rather than source timestamps",
  () =>
    Effect.gen(function* () {
      const automatic = candidate(CODEX_MODEL_SELECTION, "reactor-automatic-settlement");
      const manual = candidate(CODEX_MODEL_SELECTION, "reactor-manual-settlement");
      yield* (yield* makeImporter([automatic, manual])).run;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const automaticAt = DateTime.makeUnsafe("2026-08-01T09:00:00.000Z");
      for (const source of [automatic, manual]) {
        const threadId = importId(source);
        const thread = (yield* projections.getThreadRecords(threadId, [])).thread;
        yield* sink.write({
          commandId: CommandId.make(
            source === automatic
              ? `server:auto-settle:${threadId}:fixture`
              : `user:settle:${threadId}`,
          ),
          events: [
            {
              id: EventId.make(`settlement:${threadId}`),
              type: "thread.settled",
              threadId,
              occurredAt: now,
              payload: {
                ...thread,
                settledOverride: "settled",
                settledAt: automaticAt,
                unsettledAt: null,
              },
            },
          ],
        });
      }
      const refresh = yield* makeImporter([
        { _tag: "AlreadyImported", source: automatic.source },
        { _tag: "AlreadyImported", source: manual.source },
      ]);
      yield* refresh.run;
      expect(refresh.dispatched).toHaveLength(1);
      const command = refresh.dispatched[0];
      expect(command).toMatchObject({
        type: "thread.metadata.update",
        threadId: importId(automatic),
        expectedSettlementEventId: `settlement:${importId(automatic)}`,
      });
      if (command?.type !== "thread.metadata.update") throw new Error("Expected import repair");
      expect(DateTime.formatIso(command.clearImportedSettlement!)).toBe("2026-08-01T09:00:00.000Z");
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "keeps T3 Code provenance separate from the actual historical driver without resuming it",
  () =>
    Effect.gen(function* () {
      const original = candidate(CODEX_MODEL_SELECTION, "retained-t3-thread");
      const source: AgentSessionScanner.AgentSessionRecentThread = {
        ...original,
        source: {
          ...original.source,
          provider: "t3code",
          providerInstanceId: ProviderInstanceId.make("t3code"),
        },
        thread: {
          ...original.thread,
          source: "t3code",
          providerDriver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "retained-claude-model",
          nativeContinuation: false,
        },
      };
      const importer = yield* makeImporter([source]);
      expect(yield* importer.run).toMatchObject({
        importedCount: 1,
        nativeContinuationCount: 0,
        transcriptOnlyCount: 1,
      });
      const threadId = ThreadId.make("import:t3code:retained-t3-thread");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(threadId, [
        "messages",
        "providerThreads",
        "runs",
      ]);
      expect(records.thread.modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "retained-claude-model",
      });
      expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
      expect(records.providerThreads).toMatchObject([
        { driver: "claudeAgent", nativeThreadRef: null, status: "idle" },
      ]);
      expect(records.runs).toEqual([]);
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
        status: "stopped",
        resumeCursor: null,
      });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
      expect(importer.dispatched).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      const importer = yield* makeImporter([active, archived, deleted, otherInstance, unowned]);

      expect(yield* importer.run).toMatchObject({ importedCount: 2, skippedCount: 0 });
      for (const source of [active, archived, deleted]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned)]));
      for (const source of [otherInstance, unowned]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
          source.source.providerSessionId,
        );
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "codex"
              ? { threadId: source.source.providerSessionId }
              : { threadId, resume: source.source.providerSessionId },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toMatchObject({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toMatchObject({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toMatchObject({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("resumes a partially committed large projection without duplicate messages", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "large-projection");
    const streamed = {
      ...source,
      thread: { ...source.thread, projectionFiles: ["fixture-page"], messageCount: 2 },
    };
    let fail = true;
    const importer = yield* makeImporter([streamed], Effect.void, (thread) =>
      Stream.fromIterable(thread.messages).pipe(
        Stream.zipWithIndex,
        Stream.mapEffect(([message, index]) => {
          if (fail && index === 1) {
            fail = false;
            return Effect.fail(
              new AgentSessionScanError({
                operation: "read-projects",
                cause: "fixture interruption",
              }),
            );
          }
          return Effect.succeed(message);
        }),
      ),
    );
    expect(yield* importer.run).toMatchObject({ failedCount: 1 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(yield* projections.getMessageCount(importId(source))).toBe(1);
    expect(yield* importer.run).toMatchObject({ importedCount: 1, failedCount: 0 });
    expect(
      (yield* projections.getThreadRecords(importId(source), ["messages"])).messages.map(
        ({ text }) => text,
      ),
    ).toEqual(["Fix it", "Fixed"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);
