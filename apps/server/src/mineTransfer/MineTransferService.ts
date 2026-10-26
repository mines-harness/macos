// @effect-diagnostics-next-line nodeBuiltinImport:off -- Crypto.digest cannot hash bundles incrementally.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  MineTransferError,
  MineTransferManifest,
  MineTransferStatus,
  MINE_TRANSFER_CHUNK_BYTES,
  MINE_TRANSFER_MAX_BUNDLE_BYTES,
  ProjectId,
  ThreadId,
  TurnItemId,
  type MineTransferAcceptInput,
  type MineTransferBeginInput,
  type MineTransferChunk,
  type MineTransferFinalizeInput,
  type MineTransferIdInput,
  type MineTransferPreflightInput,
  type MineTransferPreflightResult,
  type MineTransferPrepareInput,
  type MineTransferReadChunkInput,
  type MineTransferReceipt,
  type MineTransferWriteChunkInput,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as CatalogRunContextService from "../catalog/CatalogRunContextService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GroupStore from "../groupChat/GroupStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as WorkspaceTransfer from "../workspace/WorkspaceTransfer.ts";
import * as WorkspaceRunLease from "../workspace/WorkspaceRunLease.ts";
import * as MineTransferGate from "./MineTransferGate.ts";

const TransferRecord = Schema.Struct({
  ...MineTransferStatus.fields,
  sourceThreadId: Schema.optional(ThreadId),
  destinationEnvironmentId: Schema.optional(Schema.String),
  resume: Schema.optional(Schema.Boolean),
  workspaceImported: Schema.optional(Schema.Boolean),
  wasActive: Schema.optional(Schema.Boolean),
  organizationalContext: Schema.optional(Schema.String),
});
type TransferRecord = typeof TransferRecord.Type;
const RecordJson = Schema.fromJsonString(TransferRecord);
const decodeRecord = Schema.decodeUnknownEffect(RecordJson);
const encodeRecord = Schema.encodeEffect(RecordJson);
const decodeManifest = Schema.decodeUnknownEffect(MineTransferManifest);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(MineTransferManifest));
const isTransferError = Schema.is(MineTransferError);
const isWorkspaceRejected = Schema.is(WorkspaceTransfer.WorkspaceTransferRejected);
const transferProgress = (record: TransferRecord): MineTransferStatus => ({
  transferId: record.transferId,
  role: record.role,
  status: record.status,
  receivedBytes: record.receivedBytes,
});

export class MineTransferService extends Context.Service<
  MineTransferService,
  {
    readonly preflight: (
      input: MineTransferPreflightInput,
    ) => Effect.Effect<MineTransferPreflightResult, MineTransferError>;
    readonly prepare: (
      input: MineTransferPrepareInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
    readonly readChunk: (
      input: MineTransferReadChunkInput,
    ) => Effect.Effect<MineTransferChunk, MineTransferError>;
    readonly begin: (
      input: MineTransferBeginInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
    readonly writeChunk: (
      input: MineTransferWriteChunkInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
    readonly accept: (
      input: MineTransferAcceptInput,
    ) => Effect.Effect<MineTransferReceipt, MineTransferError>;
    readonly finalize: (
      input: MineTransferFinalizeInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
    readonly cancel: (
      input: MineTransferIdInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
    readonly get: (
      input: MineTransferIdInput,
    ) => Effect.Effect<MineTransferStatus, MineTransferError>;
  }
>()("mines/mineTransfer/MineTransferService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const sink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const workspace = yield* WorkspaceTransfer.WorkspaceTransfer;
  const workspaceLeases = yield* WorkspaceRunLease.WorkspaceRunLease;
  const gate = yield* MineTransferGate.MineTransferGate;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const groups = yield* GroupStore.GroupStore;
  const runContext = yield* CatalogRunContextService.CatalogRunContextService;
  const locks = yield* KeyedLock.make<string>();
  const root = path.join(config.stateDir, "mine-transfers");
  const recordPath = (id: string) => path.join(root, `${id}.json`);
  const bundlePath = (id: string) => path.join(root, `${id}.bundle`);
  const destinationPath = (id: string) => path.join(config.worktreesDir, "transfers", id);
  const mapError = (operation: string) => (cause: unknown) => {
    if (isTransferError(cause)) return cause;
    if (WorkspaceRunLease.isWorkspaceRunLeaseBusy(cause))
      return new MineTransferError({ operation, reason: "busy", cause });
    if (isWorkspaceRejected(cause)) {
      const reason =
        cause.reason === "destination-exists" || cause.reason === "transfer-exists"
          ? "conflict"
          : cause.reason === "invalid-manifest" ||
              cause.reason === "checksum-mismatch" ||
              cause.reason === "snapshot-mismatch"
            ? "invalid-data"
            : "unsupported";
      return new MineTransferError({ operation, reason, cause });
    }
    return new MineTransferError({ operation, reason: "io", cause });
  };
  const read = Effect.fn("MineTransferService.read")(
    function* (transferId: string) {
      if (!(yield* fs.exists(recordPath(transferId)))) return undefined;
      return yield* fs.readFileString(recordPath(transferId)).pipe(Effect.flatMap(decodeRecord));
    },
    Effect.mapError(mapError("read")),
  );
  const requireRecord = Effect.fn("MineTransferService.requireRecord")(function* (
    transferId: string,
  ) {
    const record = yield* read(transferId);
    if (record === undefined)
      return yield* new MineTransferError({ operation: "read", reason: "not-found", transferId });
    return record;
  });
  const save = Effect.fn("MineTransferService.save")(
    function* (record: TransferRecord) {
      const json = yield* encodeRecord(record);
      yield* fs.makeDirectory(root, { recursive: true });
      const temporary = `${recordPath(record.transferId)}.tmp`;
      yield* fs.writeFileString(temporary, json);
      yield* fs.rename(temporary, recordPath(record.transferId));
      return record;
    },
    Effect.mapError(mapError("save")),
  );
  const ready = Effect.fn("MineTransferService.ready")(function* (model: ModelSelection) {
    const provider = (yield* providers.refreshInstance(model.instanceId)).find(
      (candidate) => candidate.instanceId === model.instanceId,
    );
    if (
      provider === undefined ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      provider.auth.status !== "authenticated" ||
      !provider.models.some((candidate) => candidate.slug === model.model)
    ) {
      return yield* new MineTransferError({
        operation: "preflight",
        reason: "provider-unavailable",
      });
    }
  });
  const get = Effect.fn("MineTransferService.get")(function* (input: MineTransferIdInput) {
    return yield* requireRecord(input.transferId);
  });
  const preflight = Effect.fn("MineTransferService.preflight")(function* (
    input: MineTransferPreflightInput,
  ) {
    yield* ready(input.modelSelection);
    return {
      environmentId: yield* identity.getEnvironmentId,
      maxBundleBytes: MINE_TRANSFER_MAX_BUNDLE_BYTES,
      chunkBytes: MINE_TRANSFER_CHUNK_BYTES,
    };
  });
  const prepare = Effect.fn("MineTransferService.prepare")(
    function* (input: MineTransferPrepareInput) {
      const existing = yield* read(input.transferId);
      if (existing !== undefined) {
        if (
          existing.role !== "source" ||
          existing.sourceThreadId !== input.threadId ||
          existing.destinationEnvironmentId !== input.destinationEnvironmentId ||
          existing.status === "cancelled"
        )
          return yield* new MineTransferError({
            operation: "prepare",
            reason: "conflict",
            transferId: input.transferId,
          });
        if (existing.manifest !== undefined) return existing;
      }
      const sourceEnvironmentId = yield* identity.getEnvironmentId;
      if (sourceEnvironmentId === input.destinationEnvironmentId)
        return yield* new MineTransferError({
          operation: "prepare",
          reason: "invalid-data",
          transferId: input.transferId,
        });
      const { before, organizationalContext } = yield* commands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const before = yield* threads.getThreadProjection(input.threadId);
          if (
            before.visibleTurnItems.some(
              ({ item }) =>
                item.type === "user_message" &&
                (item.attachments.length > 0 ||
                  item.context?.records.some(
                    (record) => record.kind === "image" || record.kind === "file",
                  )),
            )
          )
            return yield* new MineTransferError({
              operation: "prepare",
              reason: "attachments-unsupported",
              transferId: input.transferId,
            });
          if (
            before.thread.deletedAt !== null ||
            before.thread.archivedAt !== null ||
            before.thread.lineage.relationshipToParent === "subagent" ||
            before.subagents.some(
              (task) => task.status === "running" || task.origin === "app_owned",
            ) ||
            (yield* groups.membership(input.threadId, sourceEnvironmentId)) !== undefined
          )
            return yield* new MineTransferError({
              operation: "prepare",
              reason: "unsupported",
              transferId: input.transferId,
            });

          const latestRun = before.runs
            .filter((run) => run.status !== "queued")
            .toSorted((a, b) => b.ordinal - a.ordinal)[0];
          const organizationalContext =
            existing?.organizationalContext ??
            (latestRun === undefined
              ? ""
              : yield* runContext.forRun({ thread: before.thread, run: latestRun }));
          yield* save({
            transferId: input.transferId,
            role: "source",
            status: "preparing",
            receivedBytes: 0,
            sourceThreadId: input.threadId,
            destinationEnvironmentId: input.destinationEnvironmentId,
            wasActive: existing?.wasActive ?? before.runs.some(ThreadManagement.isActiveRun),
            organizationalContext,
          });
          yield* gate.freeze(input.threadId, input.transferId);
          return { before, organizationalContext };
        }),
      );
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`mine-transfer:${input.transferId}:stop`),
        threadId: input.threadId,
        reason: "Transferring mine to another environment.",
      });
      yield* worker.drain();
      const stopping = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      for (const run of stopping.runs) {
        if (run.status === "queued")
          yield* threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`mine-transfer:${input.transferId}:cancel:${run.id}`),
            threadId: input.threadId,
            runId: run.id,
          });
        else if (ThreadManagement.isActiveRun(run)) {
          const waited = yield* threads.waitForThread({
            threadId: input.threadId,
            projectId: stopping.thread.projectId,
            runId: run.id,
            timeoutMs: 60_000,
          });
          if (waited.timedOut)
            return yield* new MineTransferError({
              operation: "prepare",
              reason: "busy",
              transferId: input.transferId,
            });
        }
      }
      yield* worker.drain();
      const projection = yield* threads.getThreadProjection(input.threadId);
      if (
        projection.runs.some(ThreadManagement.isActiveRun) ||
        projection.providerThreads.some(
          (candidate) =>
            candidate.status === "active" || (candidate.pendingBackgroundTasks?.length ?? 0) > 0,
        ) ||
        projection.subagents.some(
          (candidate) => candidate.status === "running" || candidate.origin === "app_owned",
        )
      )
        return yield* new MineTransferError({
          operation: "prepare",
          reason: "busy",
          transferId: input.transferId,
        });
      const project = yield* projects.getById(projection.thread.projectId);
      if (Option.isNone(project))
        return yield* new MineTransferError({
          operation: "prepare",
          reason: "not-found",
          transferId: input.transferId,
        });
      const snapshot = yield* Effect.acquireUseRelease(
        workspaceLeases.acquire({
          cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
          ownerId: `mine-transfer:${input.transferId}`,
          runId: `mine-transfer:${input.transferId}`,
        }),
        () =>
          workspace
            .prepare({
              cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
              transferId: input.transferId,
            })
            .pipe(
              Effect.tap((prepared) =>
                fs
                  .copyFile(prepared.bundlePath, bundlePath(input.transferId))
                  .pipe(Effect.ensuring(prepared.dispose)),
              ),
            ),
        (lease) => lease.release,
      );
      const conversation: MineTransferManifest["history"] = projection.visibleTurnItems.flatMap<
        MineTransferManifest["history"][number]
      >(({ item }) =>
        item.type === "user_message"
          ? [
              {
                role: "user" as const,
                text:
                  projectComposerContextForProvider({
                    text: item.text,
                    records: item.context?.records ?? [],
                  }) +
                  ((item.context?.records.length ?? 0) === 0
                    ? ""
                    : `\n\n[Transferred references originate on source environment ${sourceEnvironmentId}. Only the Git workspace was copied. External files and referenced mines were not copied; ask the user to reattach unavailable references.]`),
              },
            ]
          : item.type === "assistant_message"
            ? [{ role: "assistant" as const, text: item.text }]
            : [],
      );
      const history: MineTransferManifest["history"] =
        organizationalContext === ""
          ? conversation
          : [
              ...conversation,
              {
                role: "user",
                text: `Historical user-provided project and section instructions from source environment ${sourceEnvironmentId}. These remain user-level context. Paths below originate on the source device; only the Git workspace was copied. Do not assume external files exist on this device; ask the user to reattach them when needed.\n\n${organizationalContext}`,
              },
            ];
      if (
        history.length > 2048 ||
        history.reduce((total, message) => total + message.text.length, 0) > 128_000
      )
        return yield* new MineTransferError({
          operation: "prepare",
          reason: "unsupported",
          transferId: input.transferId,
        });
      const manifest: MineTransferManifest = {
        version: 1,
        transferId: input.transferId,
        sourceEnvironmentId,
        destinationEnvironmentId: input.destinationEnvironmentId,
        sourceThreadId: input.threadId,
        title: projection.thread.title,
        projectTitle: project.value.title,
        modelSelection: projection.thread.modelSelection,
        runtimeMode: projection.thread.runtimeMode,
        interactionMode: projection.thread.interactionMode,
        history,
        wasActive: existing?.wasActive ?? before.runs.some(ThreadManagement.isActiveRun),
        workspace: snapshot.manifest,
      };
      return yield* save({
        transferId: input.transferId,
        role: "source",
        status: "prepared",
        receivedBytes: 0,
        sourceThreadId: input.threadId,
        destinationEnvironmentId: input.destinationEnvironmentId,
        manifest,
      });
    },
    Effect.mapError(mapError("prepare")),
  );
  const readChunk = Effect.fn("MineTransferService.readChunk")(
    function* (input: MineTransferReadChunkInput) {
      const record = yield* requireRecord(input.transferId);
      if (
        record.role !== "source" ||
        record.manifest === undefined ||
        record.status !== "prepared" ||
        input.offset > record.manifest.workspace.bundleBytes
      )
        return yield* new MineTransferError({
          operation: "read-chunk",
          reason: "conflict",
          transferId: input.transferId,
        });
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(bundlePath(input.transferId), { flag: "r" });
          yield* file.seek(BigInt(input.offset), "start");
          const bytes = yield* file.readAlloc(
            Math.min(
              MINE_TRANSFER_CHUNK_BYTES,
              record.manifest!.workspace.bundleBytes - input.offset,
            ),
          );
          return {
            offset: input.offset,
            data: Option.isSome(bytes) ? Buffer.from(bytes.value).toString("base64") : "",
            totalBytes: record.manifest!.workspace.bundleBytes,
          };
        }),
      );
    },
    Effect.mapError(mapError("read-chunk")),
  );
  const begin = Effect.fn("MineTransferService.begin")(
    function* (input: MineTransferBeginInput) {
      const manifest = yield* decodeManifest(input.manifest);
      if (
        manifest.destinationEnvironmentId !== (yield* identity.getEnvironmentId) ||
        manifest.transferId !== manifest.workspace.transferId
      )
        return yield* new MineTransferError({
          operation: "begin",
          reason: "invalid-data",
          transferId: manifest.transferId,
        });
      const existing = yield* read(manifest.transferId);
      if (existing !== undefined) {
        if (
          existing.role !== "destination" ||
          existing.status === "cancelled" ||
          (yield* encodeManifest(existing.manifest!)) !== (yield* encodeManifest(manifest))
        )
          return yield* new MineTransferError({
            operation: "begin",
            reason: "conflict",
            transferId: manifest.transferId,
          });
        return existing;
      }
      yield* ready(manifest.modelSelection);
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.writeFile(bundlePath(manifest.transferId), new Uint8Array());
      return yield* save({
        transferId: manifest.transferId,
        role: "destination",
        status: "receiving",
        receivedBytes: 0,
        manifest,
      });
    },
    Effect.mapError(mapError("begin")),
  );
  const writeChunk = Effect.fn("MineTransferService.writeChunk")(
    function* (input: MineTransferWriteChunkInput) {
      const record = yield* requireRecord(input.transferId);
      if (
        record.role !== "destination" ||
        record.status !== "receiving" ||
        record.manifest === undefined
      )
        return yield* new MineTransferError({
          operation: "write-chunk",
          reason: "conflict",
          transferId: input.transferId,
        });
      const bytes = Buffer.from(input.data, "base64");
      if (
        bytes.toString("base64") !== input.data ||
        bytes.length === 0 ||
        bytes.length > MINE_TRANSFER_CHUNK_BYTES ||
        input.offset + bytes.length > record.manifest.workspace.bundleBytes ||
        input.offset > record.receivedBytes
      )
        return yield* new MineTransferError({
          operation: "write-chunk",
          reason: "invalid-data",
          transferId: input.transferId,
        });
      if (input.offset < record.receivedBytes) {
        const contents = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(bundlePath(input.transferId), { flag: "r" });
            yield* file.seek(BigInt(input.offset), "start");
            return yield* file.readAlloc(bytes.length);
          }),
        );
        if (
          input.offset + bytes.length > record.receivedBytes ||
          Option.isNone(contents) ||
          !bytes.equals(Buffer.from(contents.value))
        )
          return yield* new MineTransferError({
            operation: "write-chunk",
            reason: "conflict",
            transferId: input.transferId,
          });
        return transferProgress(record);
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(bundlePath(input.transferId), { flag: "r+" });
          yield* file.seek(BigInt(input.offset), "start");
          yield* file.writeAll(bytes);
        }),
      );
      return transferProgress(
        yield* save({ ...record, receivedBytes: record.receivedBytes + bytes.length }),
      );
    },
    Effect.mapError(mapError("write-chunk")),
  );
  const resumeAccepted = Effect.fn("MineTransferService.resumeAccepted")(
    function* (record: TransferRecord) {
      if (!record.resume || record.receipt === undefined || record.manifest === undefined) return;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`mine-transfer:${record.transferId}:resume`),
        threadId: record.receipt.threadId,
        messageId: MessageId.make(`mine-transfer:${record.transferId}:resume`),
        text: `Continue the unfinished request from the transferred mine. The repository and conversation have been copied from environment ${record.manifest.sourceEnvironmentId}, mine ${record.manifest.sourceThreadId}. Inspect the files and continue. Use mines_thread_read on this mine to retrieve earlier imported messages if the summarized context omits details.`,
        attachments: [],
        modelSelection: record.manifest.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
    },
    Effect.mapError(mapError("resume")),
  );
  const accept = Effect.fn("MineTransferService.accept")(
    function* (input: MineTransferAcceptInput) {
      let record = yield* requireRecord(input.transferId);
      if (
        record.role !== "destination" ||
        record.manifest === undefined ||
        record.status === "cancelled" ||
        (record.resume !== undefined && record.resume !== input.resume)
      )
        return yield* new MineTransferError({
          operation: "accept",
          reason: "conflict",
          transferId: input.transferId,
        });
      if (record.status === "accepted" && record.receipt !== undefined) {
        yield* resumeAccepted(record);
        return record.receipt;
      }
      const manifest = record.manifest;
      if (record.receivedBytes !== manifest.workspace.bundleBytes)
        return yield* new MineTransferError({
          operation: "accept",
          reason: "invalid-data",
          transferId: input.transferId,
        });
      yield* ready(manifest.modelSelection);
      const info = yield* fs.stat(bundlePath(input.transferId));
      if (info.type !== "File" || info.size !== BigInt(manifest.workspace.bundleBytes))
        return yield* new MineTransferError({
          operation: "accept",
          reason: "invalid-data",
          transferId: input.transferId,
        });
      const digest = NodeCrypto.createHash("sha256");
      let receivedBytes = 0;
      yield* fs.stream(bundlePath(input.transferId)).pipe(
        Stream.runForEach((chunk) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > manifest.workspace.bundleBytes)
            return Effect.fail(
              new MineTransferError({
                operation: "accept",
                reason: "invalid-data",
                transferId: input.transferId,
              }),
            );
          digest.update(chunk);
          return Effect.void;
        }),
      );
      if (
        receivedBytes !== manifest.workspace.bundleBytes ||
        digest.digest("hex") !== manifest.workspace.bundleSha256
      )
        return yield* new MineTransferError({
          operation: "accept",
          reason: "invalid-data",
          transferId: input.transferId,
        });
      record = yield* save({ ...record, status: "accepting", resume: input.resume });
      if (!record.workspaceImported) {
        yield* fs.makeDirectory(path.dirname(destinationPath(input.transferId)), {
          recursive: true,
        });
        yield* workspace.importSnapshot({
          bundlePath: bundlePath(input.transferId),
          manifest: manifest.workspace,
          destinationPath: destinationPath(input.transferId),
        });
        record = yield* save({ ...record, workspaceImported: true });
      }
      const projectId = ProjectId.make(`mine-transfer:${input.transferId}`);
      const threadId = ThreadId.make(`mine-transfer:${input.transferId}`);
      yield* projects.create({
        commandId: CommandId.make(`mine-transfer:${input.transferId}:project`),
        projectId,
        title: manifest.projectTitle,
        workspaceRoot: destinationPath(input.transferId),
        defaultModelSelection: manifest.modelSelection,
      });
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId,
        title: manifest.title,
        providerInstanceId: manifest.modelSelection.instanceId,
        modelSelection: manifest.modelSelection,
        runtimeMode: manifest.runtimeMode,
        interactionMode: manifest.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: "active",
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "system",
        creationSource: "server",
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`mine-transfer:${input.transferId}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ];
      for (const [index, message] of manifest.history.entries()) {
        const messageId = MessageId.make(`mine-transfer:${input.transferId}:history:${index}`);
        events.push({
          id: EventId.make(`mine-transfer:${input.transferId}:message:${index}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text: message.text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: message.role === "user" ? "user" : "agent",
            creationSource: "server",
          },
        });
        const common = {
          id: TurnItemId.make(`mine-transfer:${input.transferId}:history:${index}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId,
          text: message.text,
        };
        events.push({
          id: EventId.make(`mine-transfer:${input.transferId}:item:${index}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload:
            message.role === "user"
              ? {
                  ...common,
                  type: "user_message",
                  inputIntent: "turn_start",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "server",
                }
              : { ...common, type: "assistant_message", streaming: false },
        });
      }
      yield* sink.commitCommand({
        commandId: CommandId.make(`mine-transfer:${input.transferId}:import`),
        threadId,
        commandType: "mine-transfer.import",
        acceptedAt: now,
        events,
        effects: [],
      });
      const receipt: MineTransferReceipt = {
        transferId: input.transferId,
        destinationEnvironmentId: yield* identity.getEnvironmentId,
        threadId,
        projectId,
      };
      record = yield* save({ ...record, status: "accepted", receipt });
      yield* resumeAccepted(record);
      return receipt;
    },
    Effect.mapError(mapError("accept")),
  );
  const finalize = Effect.fn("MineTransferService.finalize")(
    function* (input: MineTransferFinalizeInput) {
      const record = yield* requireRecord(input.transferId);
      if (
        record.role !== "source" ||
        record.manifest === undefined ||
        record.sourceThreadId === undefined ||
        input.receipt.transferId !== input.transferId ||
        input.receipt.destinationEnvironmentId !== record.manifest.destinationEnvironmentId ||
        (record.status !== "prepared" && record.status !== "finalized") ||
        (record.receipt !== undefined &&
          (record.receipt.threadId !== input.receipt.threadId ||
            record.receipt.projectId !== input.receipt.projectId))
      )
        return yield* new MineTransferError({
          operation: "finalize",
          reason: "conflict",
          transferId: input.transferId,
        });
      if (record.status === "finalized") return record;
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`mine-transfer:${input.transferId}:archive`),
        threadId: record.sourceThreadId,
      });
      yield* worker.drain();
      return yield* save({ ...record, status: "finalized", receipt: input.receipt });
    },
    Effect.mapError(mapError("finalize")),
  );
  const cancel = Effect.fn("MineTransferService.cancel")(
    function* (input: MineTransferIdInput) {
      const record =
        (yield* read(input.transferId)) ??
        (yield* save({
          transferId: input.transferId,
          role: "destination",
          status: "cancelled",
          receivedBytes: 0,
        }));
      if (
        record.status === "accepted" ||
        record.status === "accepting" ||
        record.status === "finalized"
      )
        return yield* new MineTransferError({
          operation: "cancel",
          reason: "conflict",
          transferId: input.transferId,
        });
      if (record.role === "source" && record.sourceThreadId !== undefined)
        yield* commands.withLock(
          record.sourceThreadId,
          gate.unfreeze(record.sourceThreadId, input.transferId),
        );
      const cancelled = yield* save({ ...record, status: "cancelled" });
      yield* fs.remove(bundlePath(input.transferId), { force: true });
      return cancelled;
    },
    Effect.mapError(mapError("cancel")),
  );
  return MineTransferService.of({
    preflight,
    prepare: (input) => locks.withLock(input.transferId, prepare(input)),
    readChunk,
    begin: (input) => locks.withLock(input.manifest.transferId, begin(input)),
    writeChunk: (input) => locks.withLock(input.transferId, writeChunk(input)),
    accept: (input) => locks.withLock(input.transferId, accept(input)),
    finalize: (input) => locks.withLock(input.transferId, finalize(input)),
    cancel: (input) => locks.withLock(input.transferId, cancel(input)),
    get,
  });
});
export const layer = Layer.effect(MineTransferService, make);
