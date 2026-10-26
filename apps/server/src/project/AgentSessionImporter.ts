import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionThreadProvenance,
  isAgentSessionGeneratedContextTitle,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);
const threadProvenance = Schema.decodeUnknownSync(AgentSessionThreadProvenance);

function importedLineage(
  threadId: ThreadId,
  providerInstanceId: string,
  source: AgentSessionThreadProvenance,
): OrchestrationV2AppThread["lineage"] {
  const nativeId = source.sourceThreadId;
  const parent =
    source.kind === "subagent" && source.sourceParentThreadId !== nativeId
      ? source.sourceParentThreadId
      : undefined;
  const root = source.sourceRootThreadId !== nativeId ? source.sourceRootThreadId : undefined;
  return {
    parentThreadId: parent ? ThreadId.make(`import:${providerInstanceId}:${parent}`) : null,
    relationshipToParent: parent ? "subagent" : null,
    rootThreadId:
      source.kind === "subagent" && (root || parent)
        ? ThreadId.make(`import:${providerInstanceId}:${root ?? parent}`)
        : threadId,
  };
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported mine '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported mine '${this.threadId}' already contains non-imported activity.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const repairImportedSettlement = Effect.fn("AgentSessionImporter.repairImportedSettlement")(
    function* (threadId: ThreadId, expectedProjectId: ProjectId, sourceAt: string | undefined) {
      if (sourceAt === undefined) return;
      const records = yield* projections.getThreadRecords(threadId, ["runs"]);
      const thread = records.thread;
      const sourceTimestamp = dateTime(sourceAt);
      if (
        thread.projectId !== expectedProjectId ||
        thread.historyOrigin !== "v1_import" ||
        thread.createdBy !== "system" ||
        thread.deletedAt !== null ||
        thread.settledOverride !== "settled" ||
        thread.settledAt === null ||
        thread.unsettledAt !== null ||
        records.runs.length > 0
      )
        return;
      const latest = yield* eventSink.latestSettlement(threadId);
      if (latest !== undefined) {
        if (
          !latest.commandId?.startsWith(`server:auto-settle:${threadId}:`) ||
          latest.event.type !== "thread.settled" ||
          latest.event.payload.settledAt === null ||
          DateTime.toEpochMillis(latest.event.payload.settledAt) !==
            DateTime.toEpochMillis(thread.settledAt)
        )
          return;
      } else if (
        DateTime.toEpochMillis(thread.settledAt) !== DateTime.toEpochMillis(sourceTimestamp)
      )
        return;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "agent-session-import",
          commandName: "repair-imported-settlement",
        }),
        threadId,
        clearImportedSettlement: thread.settledAt,
        ...(latest ? { expectedSettlementEventId: latest.event.id } : {}),
      });
    },
    Effect.orElseSucceed(() => undefined),
  );
  const repairImportedLineage = Effect.fn("AgentSessionImporter.repairImportedLineage")(
    function* (
      threadId: ThreadId,
      expectedProjectId: ProjectId,
      providerInstanceId: string,
      source: AgentSessionThreadProvenance,
    ) {
      const thread = yield* projections.getThread(threadId);
      if (
        thread.projectId !== expectedProjectId ||
        thread.historyOrigin !== "v1_import" ||
        thread.deletedAt !== null
      )
        return;
      if (thread.lineage.relationshipToParent === "fork" || source.kind !== "subagent")
        return { lineage: thread.lineage, title: thread.title };
      const lineage = importedLineage(threadId, providerInstanceId, source);
      if (lineage.parentThreadId === null) return { lineage: thread.lineage, title: thread.title };
      if (
        thread.lineage.parentThreadId === lineage.parentThreadId &&
        thread.lineage.rootThreadId === lineage.rootThreadId &&
        thread.lineage.relationshipToParent === "subagent" &&
        thread.creationSource === "provider"
      )
        return { lineage: thread.lineage, title: thread.title };
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "agent-session-import",
          commandName: "repair-native-lineage",
        }),
        threadId,
        importedLineage: lineage,
        expectedLineage: thread.lineage,
      });
      return { lineage, title: thread.title };
    },
    Effect.orElseSucceed(() => undefined),
  );
  const repairImportedTitle = Effect.fn("AgentSessionImporter.repairImportedTitle")(
    function* (threadId: ThreadId, expectedProjectId: ProjectId, nativeTitle: string) {
      const title = nativeTitle.trim();
      if (!title || isAgentSessionGeneratedContextTitle(title)) return;
      const thread = yield* projections.getThread(threadId);
      if (
        thread.projectId !== expectedProjectId ||
        thread.historyOrigin !== "v1_import" ||
        thread.deletedAt !== null
      )
        return;
      if (!isAgentSessionGeneratedContextTitle(thread.title))
        return { title: thread.title, repaired: false };
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: yield* idAllocator.allocate.command({
          fixtureName: "agent-session-import",
          commandName: "repair-native-title",
        }),
        threadId,
        title,
        expectedTitle: thread.title,
      });
      return { title, repaired: true };
    },
    Effect.orElseSucceed(() => undefined),
  );
  const persistProjectedMessages = Effect.fn("AgentSessionImporter.persistProjectedMessages")(
    function* (threadId: ThreadId, thread: AgentSessionScanner.AgentSessionThread) {
      const committedCount = yield* projections.getMessageCount(threadId);
      let index = 0;
      yield* scanner.streamMessages(thread).pipe(
        Stream.runForEach((message) => {
          const currentIndex = index++;
          return currentIndex < committedCount
            ? Effect.void
            : eventSink
                .write({ events: messageEvents({ threadId, index: currentIndex, message }) })
                .pipe(Effect.asVoid);
        }),
      );
    },
  );
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources: AgentSessionImportSource[] = [];
    const importedSourceTimes = new Map<ThreadId, string>();
    const titleRepairThreadIds: ThreadId[] = [];
    for (const runtime of runtimeRows) {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        continue;
      }
      const sources = payload.value.importedTranscripts ?? [];
      completedSources.push(...sources);
      if (
        sources.some(
          (source) =>
            runtime.threadId === `import:${source.providerInstanceId}:${source.providerSessionId}`,
        )
      )
        importedSourceTimes.set(runtime.threadId, runtime.lastSeenAt);
      if (sources.some((source) => source.provider === "codex")) {
        const thread = yield* projections.getThread(runtime.threadId).pipe(Effect.option);
        if (
          Option.isSome(thread) &&
          thread.value.historyOrigin === "v1_import" &&
          isAgentSessionGeneratedContextTitle(thread.value.title)
        )
          titleRepairThreadIds.push(runtime.threadId);
      }
    }
    const outcomes = scanner.recentThreads(
      project.workspaceRoot,
      completedSources,
      input,
      titleRepairThreadIds,
    );
    const importedThreadIds = new Set<ThreadId>();
    const catalogThreads: NonNullable<AgentSessionImportResult["catalogThreads"]>[number][] = [];
    let importedCount = 0;
    let skippedCount = 0;
    let alreadyImportedCount = 0;
    let nativeContinuationCount = 0;
    let transcriptOnlyCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let unavailableCount = 0;
    let hasMore = false;
    let nextCursor: number | undefined;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          if (outcome.reason === "deferred") {
            hasMore = true;
            nextCursor ??= outcome.cursor;
          } else {
            skippedCount += 1;
            if (outcome.reason === "unavailable") unavailableCount += 1;
            else failedCount += 1;
          }
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          yield* repairImportedSettlement(
            threadId,
            input.projectId,
            importedSourceTimes.get(threadId),
          );
          const retained = outcome.sourceThreadId
            ? yield* repairImportedLineage(
                threadId,
                input.projectId,
                source.providerInstanceId,
                outcome,
              )
            : undefined;
          const repairedTitle =
            source.provider === "codex" && outcome.nativeTitle
              ? yield* repairImportedTitle(threadId, input.projectId, outcome.nativeTitle)
              : undefined;
          importedThreadIds.add(threadId);
          importedCount += 1;
          alreadyImportedCount += 1;
          if (outcome.sourceSection || repairedTitle?.repaired || outcome.sourceThreadId)
            catalogThreads.push({
              ...threadProvenance(outcome),
              ...(retained
                ? {
                    ...(retained.lineage.parentThreadId
                      ? { parentThreadId: retained.lineage.parentThreadId }
                      : {}),
                    rootThreadId: retained.lineage.rootThreadId,
                  }
                : {}),
              threadId,
              title:
                repairedTitle?.title ??
                retained?.title ??
                (outcome.title?.trim() || "Imported mine"),
              ...(outcome.sourceSection ? { sourceSection: outcome.sourceSection } : {}),
            });
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        let repairedTitle: { title: string; repaired: boolean } | undefined;
        let retainedLineage: OrchestrationV2AppThread["lineage"] | undefined;
        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          const nativeContinuation =
            thread.kind !== "subagent" &&
            thread.nativeContinuation !== false &&
            (thread.source !== "claudeAgent" ||
              CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId));
          const driver =
            thread.providerDriver ??
            (thread.source === "t3code" ? undefined : ProviderDriverKind.make(thread.source));
          if (driver === undefined) return false;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor: !nativeContinuation
                ? null
                : thread.source === "codex"
                  ? { threadId: thread.providerSessionId }
                  : { threadId, resume: thread.providerSessionId },
              runtimePayload: {
                cwd: project.workspaceRoot,
                ...(thread.sourceThreadId
                  ? { importSourceProvenance: threadProvenance(thread) }
                  : {}),
                ...(thread.archiveAttachments?.length
                  ? { importArchiveAttachments: thread.archiveAttachments }
                  : {}),
              },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            yield* repairImportedSettlement(
              threadId,
              input.projectId,
              importedSourceTimes.get(threadId),
            );
            if (thread.source === "codex")
              repairedTitle = yield* repairImportedTitle(threadId, input.projectId, thread.title);
            if (thread.sourceThreadId)
              retainedLineage = (yield* repairImportedLineage(
                threadId,
                input.projectId,
                source.providerInstanceId,
                thread,
              ))?.lineage;
            if (thread.projectionFiles) yield* persistProjectedMessages(threadId, thread);
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId: thread.providerSessionId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: thread.kind === "subagent" ? "provider" : "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled mine" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            importedAt: yield* DateTime.now,
            ...(thread.archiveAttachments?.length
              ? { importArchiveAttachments: thread.archiveAttachments }
              : {}),
            lineage: importedLineage(threadId, source.providerInstanceId, thread),
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: nativeContinuation
              ? {
                  driver,
                  nativeId: thread.providerSessionId,
                  strength: "strong",
                }
              : null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.projectionFiles
                ? []
                : thread.messages.flatMap((message, index) =>
                    messageEvents({ threadId, index, message }),
                  )),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          if (thread.projectionFiles) yield* persistProjectedMessages(threadId, thread);
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
          if (
            outcome.thread.sourceSection ||
            repairedTitle?.repaired ||
            outcome.thread.sourceThreadId
          )
            catalogThreads.push({
              ...threadProvenance(outcome.thread),
              ...(outcome.thread.sourceThreadId
                ? (() => {
                    const lineage =
                      retainedLineage ??
                      importedLineage(threadId, source.providerInstanceId, outcome.thread);
                    return {
                      ...(lineage.parentThreadId ? { parentThreadId: lineage.parentThreadId } : {}),
                      rootThreadId: lineage.rootThreadId,
                    };
                  })()
                : {}),
              threadId,
              title: repairedTitle?.title ?? (outcome.thread.title.trim() || "Imported mine"),
              ...(outcome.thread.sourceSection
                ? { sourceSection: outcome.thread.sourceSection }
                : {}),
            });
          if (
            outcome.thread.kind !== "subagent" &&
            outcome.thread.nativeContinuation !== false &&
            (outcome.thread.source !== "claudeAgent" ||
              CLAUDE_SESSION_ID_PATTERN.test(outcome.thread.providerSessionId))
          )
            nativeContinuationCount += 1;
          else transcriptOnlyCount += 1;
          if (outcome.thread.partial) partialCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
          failedCount += 1;
        }
      }),
    );

    const sourceSection = yield* scanner.projectSourceSection(project.workspaceRoot, input);
    return {
      ...(sourceSection ? { sourceSection } : {}),
      ...(catalogThreads.length > 0 ? { catalogThreads } : {}),
      importedCount,
      skippedCount,
      alreadyImportedCount,
      nativeContinuationCount,
      transcriptOnlyCount,
      partialCount,
      failedCount,
      unavailableCount,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    } satisfies AgentSessionImportResult;
  });

  return { importRecentAgentThreads };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("mines/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
