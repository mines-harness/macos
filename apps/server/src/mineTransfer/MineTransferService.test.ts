import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  MINE_TRANSFER_CHUNK_BYTES,
  MineTransferManifest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ServerProvider,
  type WorkspaceTransferManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CatalogRunContextService from "../catalog/CatalogRunContextService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GroupStore from "../groupChat/GroupStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as WorkspaceRunLease from "../workspace/WorkspaceRunLease.ts";
import * as WorkspaceTransfer from "../workspace/WorkspaceTransfer.ts";
import * as MineTransferGate from "./MineTransferGate.ts";
import * as MineTransferService from "./MineTransferService.ts";

const layerPlatform = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mine-transfer-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const isManifest = Schema.is(MineTransferManifest);

const makeFixture = Effect.fn("MineTransferService.test.makeFixture")(function* (
  role: "source" | "destination" = "destination",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const now = yield* DateTime.now;
  const sourceEnvironmentId = EnvironmentId.make("source-environment");
  const destinationEnvironmentId = EnvironmentId.make("destination-environment");
  const threadId = ThreadId.make("thread:transfer-source");
  const projectId = ProjectId.make("project:transfer-source");
  const transferId = "test-transfer-001";
  const modelSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "test-model",
  };
  const cwd = path.join(config.baseDir, "source");
  yield* fs.makeDirectory(cwd);
  const bytes = Buffer.from("transfer bundle contents");
  const workspaceManifest: WorkspaceTransferManifest = {
    version: 1,
    transferId,
    repositoryId: "a".repeat(64),
    sourceHead: "b".repeat(40),
    snapshotCommit: "c".repeat(40),
    snapshotTree: "d".repeat(40),
    snapshotRef: `refs/mines/handoffs/${transferId}`,
    bundleSha256: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
    bundleBytes: bytes.length,
  };
  const history: Array<{ role: "user" | "assistant"; text: string }> = [
    {
      role: "user",
      text: `Original goal and constraints:\n${"Keep this requirement.\n".repeat(700)}`,
    },
    { role: "assistant", text: "The implementation is in progress." },
    { role: "user", text: "Continue and keep every original constraint." },
  ];
  const manifest: MineTransferManifest = {
    version: 1,
    transferId,
    sourceEnvironmentId,
    destinationEnvironmentId,
    sourceThreadId: threadId,
    title: "Active mine",
    projectTitle: "Transfer project",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    history,
    wasActive: true,
    workspace: workspaceManifest,
  };
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: manifest.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: manifest.runtimeMode,
    interactionMode: manifest.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    createdBy: "user",
    creationSource: "server",
  };
  const run: OrchestrationV2Run = {
    id: RunId.make("run:transfer-active"),
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:transfer-active"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const project: Project = {
    id: projectId,
    title: manifest.projectTitle,
    workspaceRoot: cwd,
    defaultModelSelection: modelSelection,
    scripts: [],
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    deletedAt: null,
  };
  const provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-25T00:00:00.000Z",
    models: [
      { slug: modelSelection.model, name: "Test model", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  };
  const state = {
    attachments: [] as Array<ChatAttachment>,
    context: undefined as OrchestrationMessageContext | undefined,
    promptOverride: undefined as string | undefined,
    activateAtLock: false,
    active: true,
    queued: true,
    organizationalContext: "",
    failSnapshot: false,
    failResume: false,
    log: [] as Array<string>,
    resumeAttempts: [] as Array<CommandId>,
    resumed: new Set<CommandId>(),
    imported: [] as Array<string>,
    projects: [] as Array<ProjectId>,
    imports: [] as Array<ReadonlyArray<OrchestrationV2DomainEvent>>,
  };
  const projection = (): OrchestrationV2ThreadProjection => ({
    thread,
    runs: [
      { ...run, status: state.active ? "running" : "interrupted" },
      {
        ...run,
        id: RunId.make("run:transfer-queued"),
        ordinal: 2,
        status: state.queued ? "queued" : "cancelled",
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: history.map((message, position) => {
      const id = TurnItemId.make(`item:transfer-history:${position}`);
      const base = {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: position,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        messageId: MessageId.make(`message:transfer-history:${position}`),
        text: position === 0 ? (state.promptOverride ?? message.text) : message.text,
      };
      return {
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: id,
        item:
          message.role === "user"
            ? {
                ...base,
                type: "user_message" as const,
                inputIntent: "turn_start" as const,
                attachments: state.attachments,
                ...(state.context === undefined ? {} : { context: state.context }),
                createdBy: "user" as const,
                creationSource: "server" as const,
              }
            : { ...base, type: "assistant_message" as const, streaming: false },
      };
    }),
    updatedAt: now,
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(CatalogRunContextService.CatalogRunContextService)({
      forRun: () => Effect.sync(() => state.organizationalContext),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(
        role === "source" ? sourceEnvironmentId : destinationEnvironmentId,
      ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: () => Effect.succeed([provider]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadProjection: () =>
        Effect.sync(() => {
          state.log.push("projection");
          return projection();
        }),
      getThreadRecords: () => Effect.sync(projection),
      dispatch: (command) =>
        Effect.gen(function* () {
          state.log.push(command.type);
          if (command.type === "queued-run.cancel") state.queued = false;
          if (command.type === "message.dispatch") {
            state.resumeAttempts.push(command.commandId);
            if (state.failResume) {
              state.failResume = false;
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
              });
            }
            state.resumed.add(command.commandId);
          }
          return { sequence: 1, storedEvents: [] };
        }),
      waitForThread: () =>
        Effect.sync(() => {
          state.log.push("wait");
          state.active = false;
          return { threadId, run: { ...run, status: "interrupted" }, timedOut: false };
        }),
    }),
    Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
      drain: () => Effect.sync(() => (state.log.push("drain"), 0)),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome(project),
      create: (input) =>
        Effect.sync(() => {
          state.projects.push(input.projectId);
          return { ...project, id: input.projectId, workspaceRoot: input.workspaceRoot };
        }),
    }),
    Layer.mock(GroupStore.GroupStore)({ membership: () => Effect.succeed(undefined) }),
    Layer.mock(WorkspaceTransfer.WorkspaceTransfer)({
      prepare: () =>
        Effect.gen(function* () {
          state.log.push("snapshot");
          if (state.failSnapshot) {
            state.failSnapshot = false;
            return yield* new WorkspaceTransfer.WorkspaceTransferRejected({
              reason: "unsupported-repository",
            });
          }
          const bundlePath = path.join(config.baseDir, "snapshot.bundle");
          yield* fs.writeFile(bundlePath, bytes).pipe(Effect.orDie);
          return { manifest: workspaceManifest, bundlePath, dispose: Effect.void };
        }),
      importSnapshot: (input) =>
        Effect.sync(() => {
          state.imported.push(input.destinationPath);
          return { cwd: input.destinationPath, head: input.manifest.sourceHead };
        }),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      commitCommand: (input) =>
        Effect.sync(() => {
          state.imports.push(input.events);
          return {
            receipt: {
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: input.commandType,
              acceptedAt: now,
              resultSequence: 1,
              status: "accepted",
              error: null,
            },
            storedEvents: [],
            committed: true,
            cancelledEffectCount: 0,
          };
        }),
    }),
  );
  const executor = yield* KeyedLock.make<ThreadId>();
  const transferCommands = ThreadCommandExecutor.ThreadCommandExecutor.of({
    activeKeys: executor.activeKeys,
    withLock: (id, effect) =>
      executor.withLock(
        id,
        Effect.sync(() => {
          if (state.activateAtLock) {
            state.active = true;
            state.activateAtLock = false;
          }
        }).pipe(Effect.andThen(effect)),
      ),
  });
  const layer = MineTransferService.layer.pipe(
    Layer.provideMerge(MineTransferGate.layer),
    Layer.provide(Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, transferCommands)),
    Layer.provide(WorkspaceRunLease.layer),
    Layer.provide(dependencies),
  );
  const context = yield* Layer.build(layer);
  const service = Context.get(context, MineTransferService.MineTransferService);
  const gate = Context.get(context, MineTransferGate.MineTransferGate);
  const prepare = () => service.prepare({ transferId, threadId, destinationEnvironmentId });
  const receive = () =>
    service
      .begin({ manifest })
      .pipe(
        Effect.andThen(
          service.writeChunk({ transferId, offset: 0, data: bytes.toString("base64") }),
        ),
      );
  return {
    service,
    gate,
    state,
    manifest,
    bytes,
    transferId,
    threadId,
    fs,
    path,
    config,
    prepare,
    receive,
  };
});

it.effect("stops and drains the source before snapshotting and holds it until cancellation", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    const prepared = yield* fixture.prepare();
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.manifest?.wasActive, true);
    assert.isAbove(fixture.manifest.history[0]!.text.length, 14_000);
    assert.deepEqual(prepared.manifest?.history, fixture.manifest.history);
    assert.deepEqual(fixture.state.log, [
      "projection",
      "thread.stop",
      "drain",
      "wait",
      "queued-run.cancel",
      "drain",
      "projection",
      "snapshot",
    ]);
    assert.equal(
      (yield* fixture.gate.assertAvailable(fixture.threadId).pipe(Effect.flip)).reason,
      "busy",
    );
    assert.equal(
      (yield* fixture.service.get({ transferId: fixture.transferId })).status,
      "prepared",
    );
    assert.isFalse(fixture.state.log.includes("thread.archive"));
    yield* fixture.service.cancel({ transferId: fixture.transferId });
    yield* fixture.gate.assertAvailable(fixture.threadId);
    assert.equal(
      (yield* fixture.service.get({ transferId: fixture.transferId })).status,
      "cancelled",
    );
    assert.isFalse(fixture.state.log.includes("thread.archive"));
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("remembers an active source when snapshot preparation fails and is retried", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    fixture.state.failSnapshot = true;
    assert.equal((yield* fixture.prepare().pipe(Effect.flip)).reason, "unsupported");
    assert.isFalse(fixture.state.active);
    assert.equal(
      (yield* fixture.service.get({ transferId: fixture.transferId })).status,
      "preparing",
    );
    assert.equal((yield* fixture.prepare()).manifest?.wasActive, true);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("persists cancellation before a late destination begin arrives", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.service.cancel({ transferId: fixture.transferId });
    assert.equal(
      (yield* fixture.service.begin({ manifest: fixture.manifest }).pipe(Effect.flip)).reason,
      "conflict",
    );
    assert.equal(
      (yield* fixture.service.get({ transferId: fixture.transferId })).status,
      "cancelled",
    );
    assert.deepEqual(fixture.state.imported, []);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect(
  "accepts identical chunk retries without growing the bundle and rejects invalid writes",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.service.begin({ manifest: fixture.manifest });
      const input = {
        transferId: fixture.transferId,
        offset: 0,
        data: fixture.bytes.toString("base64"),
      };
      yield* fixture.service.writeChunk(input);
      const retried = yield* fixture.service.writeChunk(input);
      assert.equal(retried.receivedBytes, fixture.bytes.length);
      const bundlePath = fixture.path.join(
        fixture.config.stateDir,
        "mine-transfers",
        `${fixture.transferId}.bundle`,
      );
      assert.deepEqual(Buffer.from(yield* fixture.fs.readFile(bundlePath)), fixture.bytes);
      assert.equal(
        (yield* fixture.service
          .writeChunk({ ...input, data: Buffer.alloc(fixture.bytes.length).toString("base64") })
          .pipe(Effect.flip)).reason,
        "conflict",
      );
      assert.equal(
        (yield* fixture.service
          .writeChunk({
            ...input,
            data: Buffer.alloc(MINE_TRANSFER_CHUNK_BYTES + 1).toString("base64"),
          })
          .pipe(Effect.flip)).reason,
        "invalid-data",
      );
      assert.equal(
        (yield* fixture.service
          .writeChunk({ ...input, offset: fixture.bytes.length, data: "YQ==" })
          .pipe(Effect.flip)).reason,
        "invalid-data",
      );
      assert.equal(
        (yield* fixture.service.get({ transferId: fixture.transferId })).receivedBytes,
        fixture.bytes.length,
      );
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("rejects a checksum mismatch before importing any workspace or thread", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const manifest = {
      ...fixture.manifest,
      workspace: { ...fixture.manifest.workspace, bundleSha256: "0".repeat(64) },
    };
    assert.isTrue(isManifest(manifest));
    yield* fixture.service.begin({ manifest });
    yield* fixture.service.writeChunk({
      transferId: fixture.transferId,
      offset: 0,
      data: fixture.bytes.toString("base64"),
    });
    assert.equal(
      (yield* fixture.service
        .accept({ transferId: fixture.transferId, resume: true })
        .pipe(Effect.flip)).reason,
      "invalid-data",
    );
    assert.deepEqual(fixture.state.imported, []);
    assert.deepEqual(fixture.state.projects, []);
    assert.deepEqual(fixture.state.imports, []);
    assert.deepEqual(fixture.state.resumeAttempts, []);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("replays the same accepted receipt and resume command without importing twice", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.receive();
    const input = { transferId: fixture.transferId, resume: true };
    const first = yield* fixture.service.accept(input);
    const second = yield* fixture.service.accept(input);
    assert.deepEqual(second, first);
    assert.equal(fixture.state.imported.length, 1);
    assert.equal(fixture.state.projects.length, 1);
    assert.equal(fixture.state.imports.length, 1);
    assert.deepEqual(
      fixture.state.imports.flatMap((events) =>
        events.flatMap((event) =>
          event.type === "message.updated"
            ? [{ role: event.payload.role, text: event.payload.text }]
            : [],
        ),
      ),
      [...fixture.manifest.history],
    );
    assert.deepEqual(fixture.state.resumeAttempts, [
      CommandId.make(`mine-transfer:${fixture.transferId}:resume`),
      CommandId.make(`mine-transfer:${fixture.transferId}:resume`),
    ]);
    assert.equal(fixture.state.resumed.size, 1);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("retries a failed resume after the accepted transfer has been persisted", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.receive();
    fixture.state.failResume = true;
    const input = { transferId: fixture.transferId, resume: true };
    assert.equal((yield* fixture.service.accept(input).pipe(Effect.flip)).reason, "io");
    const persisted = yield* fixture.service.get({ transferId: fixture.transferId });
    assert.equal(persisted.status, "accepted");
    assert.isDefined(persisted.receipt);
    const receipt = yield* fixture.service.accept(input);
    assert.deepEqual(receipt, persisted.receipt);
    assert.equal(fixture.state.imported.length, 1);
    assert.equal(fixture.state.imports.length, 1);
    assert.equal(fixture.state.resumeAttempts.length, 2);
    assert.equal(fixture.state.resumeAttempts[0], fixture.state.resumeAttempts[1]);
    assert.equal(fixture.state.resumed.size, 1);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("refuses conversation attachments before freezing or stopping the source", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    fixture.state.attachments.push({
      type: "file",
      id: "attachment-transfer-test",
      name: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
    });
    const error = yield* fixture.prepare().pipe(Effect.flip);
    assert.equal(error.reason, "attachments-unsupported");
    assert.include(error.message, "conversation attachments");
    assert.deepEqual(fixture.state.log, ["projection"]);
    yield* fixture.gate.assertAvailable(fixture.threadId);
  }).pipe(Effect.provide(layerPlatform)),
);

it.effect("preserves the source run's organizational instructions as historical user context", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    fixture.state.organizationalContext =
      "The section requires that every deployment is reviewed. External source: /source/private-guidance.md";
    const prepared = yield* fixture.prepare();
    const last = prepared.manifest!.history.at(-1)!;
    assert.equal(last.role, "user");
    assert.include(last.text, fixture.state.organizationalContext);
    assert.include(last.text, "only the Git workspace was copied");
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("observes a run that starts before the transfer acquires its command lock", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    fixture.state.active = false;
    fixture.state.activateAtLock = true;
    assert.equal((yield* fixture.prepare()).manifest?.wasActive, true);
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("preserves structured terminal context in the portable user history", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("source");
    fixture.state.promptOverride =
      "Fix the failure in [Terminal 1](mines-context://v1/terminal/ctx_t).";
    fixture.state.context = {
      version: 1,
      records: [
        {
          version: 1,
          kind: "terminal",
          contextId: ComposerContextId.make("ctx_t"),
          label: "Terminal 1",
          terminalId: "terminal-1",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "critical build failure",
        },
      ],
    };
    const first = (yield* fixture.prepare()).manifest!.history[0]!;
    assert.include(first.text, "critical build failure");
    assert.include(first.text, "External files and referenced mines were not copied");
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);
