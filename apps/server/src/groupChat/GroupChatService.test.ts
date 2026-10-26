import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  GroupChatError,
  GroupId,
  IsoDateTime,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
  type GroupSnapshot,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import type { SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as GroupChatService from "./GroupChatService.ts";
import * as GroupPeerStore from "./GroupPeerStore.ts";
import * as SharedGroupService from "./SharedGroupService.ts";
import * as SharedGroupTransport from "./SharedGroupTransport.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as AccountFailoverService from "../orchestration-v2/AccountFailoverService.ts";
import * as RemoteGroupTransport from "./RemoteGroupTransport.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const ux = ThreadId.make("original:ux");
const ui = ThreadId.make("original:ui");
const fixture = (
  completeImmediately = false,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly request?: RemoteGroupTransport.RemoteGroupTransport["Service"]["request"];
    readonly relevance?: NonNullable<ProviderTextGeneration["assessGroupRelevance"]>;
  } = {},
) => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>(
    [ux, ui].map((id) => [id, idleThreadProjection(liveThreadShell(id))]),
  );
  const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const receipts = new Map<string, ThreadManagement.ThreadManagementSendResult>();
  const projection = (id: ThreadId) => {
    const record = projections.get(id);
    if (!record) throw new Error("Unknown test thread");
    return record;
  };
  const instanceId = projection(ux).thread.providerInstanceId;
  const driverKind = ProviderDriverKind.make("codex");
  const unused = () => Effect.die("This group test must not call unrelated provider operations");
  const instance: ProviderInstance = {
    instanceId,
    driverKind,
    continuationIdentity: { driverKind, continuationKey: "group-test" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: unused(),
      refresh: unused(),
      streamChanges: Stream.empty,
      resolveMaintenance: unused,
      applyUsageLimits: unused,
    },
    orchestrationAdapter: {
      instanceId,
      driver: driverKind,
      getCapabilities: unused,
      planSelectionTransition: unused,
      openSession: unused,
    },
    textGeneration: {
      ...(options.relevance ? { assessGroupRelevance: options.relevance } : {}),
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
      generateReviewGuide: unused,
    },
  };
  const finish = (id: ThreadId, text: string) => {
    const record = projection(id);
    const run = record.runs.at(-1);
    if (!run) throw new Error("Expected native run");
    projections.set(id, {
      ...record,
      runs: record.runs.map((candidate) =>
        candidate.id === run.id
          ? { ...candidate, status: "completed", completedAt: record.updatedAt }
          : candidate,
      ),
      turnItems: [
        ...record.turnItems,
        {
          id: TurnItemId.make(`reply:${run.id}`),
          threadId: id,
          runId: run.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: record.turnItems.length,
          status: "completed",
          title: null,
          startedAt: record.updatedAt,
          completedAt: record.updatedAt,
          updatedAt: record.updatedAt,
          type: "assistant_message",
          text,
          messageId: MessageId.make(`message:${run.id}`),
          streaming: false,
        },
      ],
    });
  };
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(null),
    getThreadRecords: (id, _fields, filter) =>
      Effect.sync(() => {
        const record = projection(id);
        return {
          ...record,
          runs: filter?.runIds
            ? record.runs.filter((run) => filter.runIds?.includes(run.id))
            : record.runs,
          turnItems: filter?.turnItemRunId
            ? record.turnItems.filter((item) => item.runId === filter.turnItemRunId)
            : record.turnItems,
        };
      }),
    sendToThread: (input) =>
      Effect.sync(() => {
        const prior = receipts.get(input.commandId);
        if (prior) return prior;
        sends.push(input);
        const record = projection(input.threadId);
        const at = record.updatedAt;
        const run: OrchestrationV2Run = {
          id: RunId.make(`native:${input.messageId}`),
          threadId: input.threadId,
          ordinal: record.runs.length + 1,
          providerInstanceId: record.thread.providerInstanceId,
          modelSelection: record.thread.modelSelection,
          providerThreadId: null,
          userMessageId: input.messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: at,
          startedAt: at,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          id: MessageId.make(input.messageId),
          threadId: input.threadId,
          runId: run.id,
          nodeId: null,
          role: "user",
          text: input.text,
          attachments: [],
          streaming: false,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          createdAt: at,
          updatedAt: at,
        };
        const next = {
          ...record,
          runs: [...record.runs, run],
          messages: [...record.messages, message],
        };
        projections.set(input.threadId, next);
        if (completeImmediately)
          finish(input.threadId, `Reply ${sends.length} by ${input.threadId}`);
        const result: ThreadManagement.ThreadManagementSendResult = {
          dispatch: { sequence: sends.length, storedEvents: [] },
          projection: next,
          message,
          run,
          turnItem: null,
          delivery: "started",
        };
        receipts.set(input.commandId, result);
        return result;
      }),
  });
  return {
    sends,
    projections,
    finish,
    fail: (id: ThreadId) => {
      const record = projection(id);
      const run = record.runs.at(-1);
      if (!run) throw new Error("Expected native run");
      projections.set(id, {
        ...record,
        runs: record.runs.map((candidate) =>
          candidate.id === run.id
            ? { ...candidate, status: "failed", completedAt: record.updatedAt }
            : candidate,
        ),
      });
    },
    layer: GroupChatService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          NodeCrypto.layer,
          threads,
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (projectId) =>
              Effect.succeed(
                Option.some({
                  projectId,
                  title: "Project",
                  workspaceRoot: "/group-test",
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
                  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
                  deletedAt: null,
                }),
              ),
          }),
          Layer.mock(AccountFailoverService.AccountFailoverService)({
            recover: () => Effect.succeed("not_applicable"),
          }),
          Layer.mock(RemoteGroupTransport.RemoteGroupTransport)({
            changes: Stream.empty,
            ...(options.request ? { request: options.request } : {}),
          }),
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(
              options.environmentId ?? EnvironmentId.make("coordinator"),
            ),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(options.relevance ? instance : undefined),
          }),
        ),
      ),
    ),
  };
};

const until = (
  groups: GroupChatService.GroupChatService["Service"],
  id: GroupSnapshot["group"]["id"],
  predicate: (snapshot: GroupSnapshot) => boolean,
) =>
  groups
    .subscribe({ groupId: id })
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

it.effect("persists the authorized shared service lifecycle without starting native AI", () => {
  const native = fixture();
  const identity = createPeerIdentity(new Uint8Array(32).fill(53), "Coordinator");
  const input = {
    groupKey: "shared-persistence-123",
    coordinatorDeviceId: identity.device.deviceId,
  };
  let selections: ReadonlyArray<ThreadId> = [];
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      visibility: "shared",
      name: "Friends",
      workflow: "team",
      members: [],
      clientRequestId: "shared-integration-create",
    });
    const grant: SharedGroupDeviceGrant = {
      groupKey: input.groupKey,
      groupId: created.group.id,
      coordinatorEnvironmentId: "coordinator",
      coordinatorDevice: identity.device,
      from: identity.device,
      to: identity.device,
      fromFriendId: "mines-11111111111111111111",
      toFriendId: "mines-11111111111111111111",
      updatedAt: created.group.updatedAt,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(GroupChatService.GroupChatService, groups),
      GroupPeerStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      Layer.mock(PeerTrustStore.PeerTrustStore)({ identity: Effect.succeed(identity) }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("coordinator")),
      }),
      Layer.mock(SharedGroupTransport.SharedGroupTransport)({
        register: () => () => {},
        authorize: () => Effect.succeed(grant),
        selected: () => Effect.sync(() => selections),
        select: (_key, ids, selected) =>
          Effect.sync(() => {
            selections = selected
              ? [...new Set([...selections, ...ids])]
              : selections.filter((id) => !ids.includes(id));
          }),
        disconnect: () => Effect.void,
      }),
    );
    yield* Effect.gen(function* () {
      const shared = yield* SharedGroupService.SharedGroupService;
      const note = yield* shared.send({
        ...input,
        message: "@everyone hello",
        clientRequestId: "shared-note",
      });
      assert.equal(note.snapshot?.messages[0]?.authorFriendId, grant.fromFriendId);
      assert.equal(note.snapshot?.messages[0]?.roundId, null);
      assert.deepEqual(note.snapshot?.rounds, []);
      const added = yield* shared.addChats({
        ...input,
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "shared-select",
      });
      assert.equal(added.snapshot?.group.leadMemberId, added.snapshot?.members[0]?.id);
      assert.deepEqual(added.selectedThreadIds, [ux]);
      yield* shared.removeChats({ ...input, threadIds: [ux] });
      assert.deepEqual(selections, []);
      yield* shared.addChats({
        ...input,
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "shared-reselect",
      });
      yield* shared.leave(input);
      assert.deepEqual(selections, []);
    }).pipe(Effect.provide(SharedGroupService.layer.pipe(Layer.provide(dependencies))));
    const persisted = yield* groups.get({ groupId: created.group.id });
    assert.deepEqual(persisted.members, []);
    assert.equal(persisted.messages.length, 1);
    assert.deepEqual(persisted.rounds, []);
    assert.deepEqual((yield* groups.list()).memberships, []);
    assert.equal(native.projections.has(ux), true);
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});

it.effect("creates an empty shared team and assigns its first AI conversation as lead", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const input = {
      visibility: "shared" as const,
      name: "Friends",
      workflow: "team" as const,
      members: [],
      clientRequestId: "shared-empty",
    };
    const created = yield* groups.create(input);
    assert.equal(created.group.visibility, "shared");
    assert.equal(created.group.leadMemberId, "");
    assert.deepEqual(created.members, []);
    assert.equal((yield* groups.create(input)).group.id, created.group.id);
    assert.equal(
      (yield* groups
        .addMembers({
          groupId: created.group.id,
          members: [{ threadId: ux, alias: "UX" }],
          clientRequestId: "untrusted-first-ai",
        })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    const added = yield* groups.addSharedMembers({
      groupId: created.group.id,
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "first-ai",
    });
    assert.equal(added.group.leadMemberId, added.members[0]?.id);
    assert.deepEqual((yield* groups.list()).memberships, []);
    assert.equal(native.sends.length, 0);
    assert.equal(
      (yield* groups
        .create({ ...input, visibility: "private", clientRequestId: "private-empty" })
        .pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(native.layer));
});

it.effect(
  "saves shared human messages without AI routing and binds retries to the trusted author",
  () => {
    let assessments = 0;
    const native = fixture(false, {
      relevance: () =>
        Effect.sync(() => {
          assessments++;
          return { decision: "reply" as const };
        }),
    });
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        visibility: "shared",
        name: "Friends",
        workflow: "team",
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "shared-create",
      });
      const input = {
        groupId: created.group.id,
        message: "@everyone hello friends",
        clientRequestId: "human-message",
      };
      const author = "mines-11111111111111111111";
      const sent = yield* groups.sendShared(input, author);
      assert.equal(sent.rounds.length, 0);
      assert.equal(sent.messages.length, 1);
      assert.equal(sent.messages[0]?.roundId, null);
      assert.equal(sent.messages[0]?.authorFriendId, author);
      yield* groups.sendShared(input, author);
      assert.equal((yield* groups.get({ groupId: created.group.id })).messages.length, 1);
      assert.equal(
        (yield* groups.sendShared(input, "mines-22222222222222222222").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* groups.send({ ...input, clientRequestId: "untrusted-send" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(native.sends.length, 0);
      assert.equal(assessments, 0);
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("runs shared AI only on explicit request without private catalog context", () => {
  const native = fixture(true);
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      visibility: "shared",
      name: "Friends",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "shared-ai-create",
    });
    yield* groups.sendShared(
      {
        groupId: created.group.id,
        message: "@everyone reply once",
        requestAiResponse: true,
        catalogContextRevision: { accountId: "private-owner", stateVector: "AA==" },
        clientRequestId: "explicit-ai",
      },
      "mines-11111111111111111111",
    );
    const completed = yield* until(
      groups,
      created.group.id,
      (snapshot) => snapshot.rounds[0]?.status === "completed",
    );
    assert.equal(native.sends.length, 1);
    assert.equal(native.sends[0]?.catalogContextRevision, undefined);
    assert.equal(completed.rounds[0]?.catalogContextRevision, undefined);
    assert.equal(completed.messages[0]?.authorFriendId, "mines-11111111111111111111");
  }).pipe(Effect.provide(native.layer));
});

it.effect("removes shared AI membership without deleting history or original conversations", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      visibility: "shared",
      name: "Friends",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "removal-create",
    });
    yield* groups.sendShared(
      {
        groupId: created.group.id,
        message: "Keep this history",
        clientRequestId: "before-removal",
      },
      "mines-11111111111111111111",
    );
    const input = { groupId: created.group.id, memberIds: [created.members[0]!.id] };
    const removed = yield* groups.removeMembers(input);
    assert.deepEqual(removed.members, []);
    assert.equal(removed.group.leadMemberId, "");
    assert.equal(removed.messages[0]?.text, "Keep this history");
    assert.deepEqual((yield* groups.removeMembers(input)).members, []);
    const replacement = yield* groups.create({
      name: "Private follow-up",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "private-follow-up",
    });
    assert.equal(replacement.members[0]?.threadId, ux);
    assert.equal(native.projections.get(ux)?.thread.id, ux);
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});

it.effect(
  "keeps human chat available during an AI round and delays member removal until it ends",
  () => {
    const native = fixture();
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        visibility: "shared",
        name: "Friends",
        workflow: "team",
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "active-shared-create",
      });
      yield* groups.sendShared(
        {
          groupId: created.group.id,
          message: "@UX start",
          requestAiResponse: true,
          clientRequestId: "active-ai",
        },
        "mines-11111111111111111111",
      );
      yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.deliveries[0]?.status === "running",
      );
      const human = yield* groups.sendShared(
        { groupId: created.group.id, message: "I will review it", clientRequestId: "during-ai" },
        "mines-22222222222222222222",
      );
      assert.equal(human.rounds.length, 1);
      assert.equal(human.messages.filter((entry) => entry.kind === "user").length, 2);
      assert.equal(native.sends.length, 1);
      const removal = { groupId: created.group.id, memberIds: [created.members[0]!.id] };
      assert.equal((yield* Effect.flip(groups.removeMembers(removal))).code, "busy");
      native.finish(ux, "Finished");
      yield* groups.reconcile();
      yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      const removed = yield* groups.removeMembers(removal);
      assert.deepEqual(removed.members, []);
      assert.equal(removed.rounds[0]?.members[0]?.threadId, ux);
      assert.ok(removed.messages.some((entry) => entry.text === "Finished"));
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("durably releases a removed remote AI reservation once", () => {
  const releases: string[] = [];
  const thread = idleThreadProjection(liveThreadShell(ux)).thread;
  const native = fixture(false, {
    request: (_, input) => {
      if (input.type === "describe")
        return Effect.succeed({
          type: "description" as const,
          threadId: ux,
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
        });
      if (input.type === "release") releases.push(input.memberId);
      return Effect.succeed({ type: "ok" as const });
    },
  });
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      visibility: "shared",
      name: "Remote friends",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX", environmentId: EnvironmentId.make("participant") }],
      clientRequestId: "remote-remove-create",
    });
    const input = { groupId: created.group.id, memberIds: [created.members[0]!.id] };
    yield* groups.removeMembers(input);
    yield* groups.reconcile();
    yield* groups.removeMembers(input);
    yield* groups.reconcile();
    assert.deepEqual(releases, [created.members[0]!.id]);
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});

it.effect("adds participants once and exposes active membership refs without starting work", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      name: "Design",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "create",
    });
    const input = {
      groupId: created.group.id,
      members: [
        { threadId: ux, alias: "UX", environmentId: EnvironmentId.make("coordinator") },
        { threadId: ui, alias: "UI" },
        { threadId: ui, alias: "UI" },
      ],
      clientRequestId: "add",
    };
    const added = yield* groups.addMembers(input);
    const replay = yield* groups.addMembers(input);
    assert.deepEqual(replay, added);
    assert.deepEqual(
      added.members.map((member) => member.threadId),
      [ux, ui],
    );
    assert.equal(added.group.leadMemberId, created.group.leadMemberId);
    assert.equal(added.messages.length, 0);
    assert.equal(added.rounds.length, 0);
    assert.equal(native.sends.length, 0);
    assert.deepEqual(
      (yield* groups.list()).memberships,
      [ux, ui].map((threadId) => ({
        groupId: created.group.id,
        threadId,
        environmentId: null,
      })),
    );
    yield* groups.archive({ groupId: created.group.id, archived: true });
    assert.deepEqual((yield* groups.list()).memberships, []);
  }).pipe(Effect.provide(native.layer));
});

it.effect(
  "rejects invalid participant additions atomically and binds retries to their content",
  () => {
    const native = fixture();
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        name: "Design",
        workflow: "team",
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "create",
      });
      for (const alias of ["UX", "everyone"]) {
        const invalid = yield* groups
          .addMembers({
            groupId: created.group.id,
            members: [{ threadId: ui, alias }],
            clientRequestId: `invalid-${alias}`,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal((yield* groups.get({ groupId: created.group.id })).members.length, 1);
      }
      const record = native.projections.get(ui)!;
      for (const patch of [
        { archivedAt: record.updatedAt },
        { deletedAt: record.updatedAt },
        { lineage: { ...record.thread.lineage, relationshipToParent: "subagent" as const } },
      ]) {
        native.projections.set(ui, { ...record, thread: { ...record.thread, ...patch } });
        const invalid = yield* groups
          .addMembers({
            groupId: created.group.id,
            members: [{ threadId: ui, alias: "UI" }],
            clientRequestId: "inactive",
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
      }
      native.projections.set(ui, record);
      yield* groups.addMembers({
        groupId: created.group.id,
        members: [{ threadId: ui, alias: "UI" }],
        clientRequestId: "add",
      });
      const reused = yield* groups
        .addMembers({
          groupId: created.group.id,
          members: [{ threadId: ui, alias: "Different" }],
          clientRequestId: "add",
        })
        .pipe(Effect.result);
      assert.equal(reused._tag, "Failure");
      yield* groups.archive({ groupId: created.group.id, archived: true });
      const archived = yield* groups
        .addMembers({
          groupId: created.group.id,
          members: [{ threadId: ui, alias: "UI" }],
          clientRequestId: "archived",
        })
        .pipe(Effect.result);
      assert.equal(archived._tag, "Failure");
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("requires the existing approved peer route before adding a remote participant", () => {
  const requests: string[] = [];
  const native = fixture(false, {
    request: (_host, request) => {
      requests.push(request.type);
      return Effect.fail(new GroupChatError({ code: "dispatch", message: "Unapproved device" }));
    },
  });
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      name: "Design",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "create",
    });
    const rejected = yield* groups
      .addMembers({
        groupId: created.group.id,
        members: [
          { threadId: ui, alias: "UI", environmentId: EnvironmentId.make("other-account") },
        ],
        clientRequestId: "remote",
      })
      .pipe(Effect.result);
    assert.equal(rejected._tag, "Failure");
    assert.deepEqual(requests, ["describe"]);
    assert.equal((yield* groups.get({ groupId: created.group.id })).members.length, 1);
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});

it.effect(
  "dispatches a broadcast once per original thread and streams the durable completion",
  () => {
    const native = fixture(true);
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        name: "Design",
        workflow: "team",
        members: [
          { threadId: ux, alias: "UX" },
          { threadId: ui, alias: "UI" },
        ],
        clientRequestId: "create",
      });
      const input = {
        groupId: created.group.id,
        message: "@everyone improve this",
        clientRequestId: "send",
      };
      yield* groups.send(input);
      const completed = yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      yield* groups.send(input);
      assert.deepEqual(native.sends.map((send) => send.threadId).sort(), [ui, ux].sort());
      assert.equal(new Set(native.sends.map((send) => send.commandId)).size, 2);
      assert.equal(completed.messages.filter((message) => message.kind === "assistant").length, 2);
      assert.equal(completed.rounds[0]?.deliveries.length, 2);
      assert.ok(
        native.sends.every((send) => send.text.includes("@UX") && send.text.includes("@UI")),
      );
      assert.ok(
        native.sends.every((send) => send.text.includes("Reply once. Do not call group_ask")),
      );
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("rejects explicit and direct invitations throughout an everyone broadcast", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      name: "Broadcast",
      workflow: "team",
      members: [
        { threadId: ux, alias: "UX" },
        { threadId: ui, alias: "UI" },
      ],
      clientRequestId: "create-broadcast",
    });
    yield* groups.send({
      groupId: created.group.id,
      message: "@everyone reply once",
      clientRequestId: "broadcast",
    });
    yield* until(
      groups,
      created.group.id,
      (snapshot) =>
        snapshot.rounds[0]?.deliveries.every((delivery) => delivery.status === "running") === true,
    );
    for (const [source, target] of [
      [ux, ui],
      [ui, ux],
    ] as const) {
      const invitation = yield* groups
        .ask(source, {
          targetMemberId: target === ui ? "@UI" : "@UX",
          message: "Keep discussing",
          clientRequestId: `ask-${source}`,
        })
        .pipe(Effect.result);
      assert.equal(invitation._tag, "Failure");
      assert.equal(
        (yield* groups.assertDirectSendAllowed(source, target).pipe(Effect.result))._tag,
        "Failure",
      );
    }
    native.finish(ux, "@UI please reply again");
    native.finish(ui, "@UX another question");
    yield* groups.reconcile();
    const completed = yield* until(
      groups,
      created.group.id,
      (snapshot) => snapshot.rounds[0]?.status === "completed",
    );
    assert.equal(native.sends.length, 2);
    assert.equal(completed.rounds[0]?.deliveries.length, 2);
  }).pipe(Effect.provide(native.layer));
});

it.effect.each(["local", "remote"] as const)(
  "preserves the original run context through repeated %s group retries",
  (location) =>
    Effect.gen(function* () {
      const hostId = EnvironmentId.make("retry-participant");
      const native = fixture(false, { environmentId: hostId });
      const nativeContext = yield* Layer.build(native.layer);
      const host = Context.get(nativeContext, GroupChatService.GroupChatService);
      const coordinator =
        location === "local"
          ? null
          : fixture(false, {
              request: (_environmentId, input) =>
                host.peer(EnvironmentId.make("coordinator"), input),
            });
      const groups = coordinator
        ? Context.get(yield* Layer.build(coordinator.layer), GroupChatService.GroupChatService)
        : host;
      const created = yield* groups.create({
        name: "Retry context",
        workflow: "team",
        members: [
          {
            threadId: ux,
            alias: "UX",
            ...(location === "remote" ? { environmentId: hostId } : {}),
          },
        ],
        clientRequestId: "retry-create",
      });
      const revision = { accountId: "owner", stateVector: "AA==" };
      const sendInput = {
        groupId: created.group.id,
        message: "@UX complete the design",
        clientRequestId: "retry-send",
        catalogContextRevision: revision,
      };
      yield* groups.send(sendInput);
      let snapshot = yield* until(
        groups,
        created.group.id,
        (current) => current.rounds[0]?.deliveries[0]?.status === "running",
      );
      const originalRunId = snapshot.rounds[0]!.deliveries[0]!.runId;
      assert.deepEqual(native.sends.at(-1)?.catalogContextRevision, revision);
      yield* groups.send({
        ...sendInput,
        catalogContextRevision: { ...revision, stateVector: "AQ==" },
      });
      assert.equal((yield* groups.get({ groupId: created.group.id })).rounds.length, 1);
      for (let retry = 0; retry < 2; retry++) {
        native.fail(ux);
        yield* groups.reconcile();
        snapshot = yield* until(
          groups,
          created.group.id,
          (current) => current.rounds[0]?.deliveries[0]?.status === "failed",
        );
        yield* groups.retry({
          groupId: created.group.id,
          roundId: snapshot.rounds[0]!.id,
          deliveryId: snapshot.rounds[0]!.deliveries[0]!.id,
        });
        snapshot = yield* until(
          groups,
          created.group.id,
          (current) => current.rounds[0]?.deliveries[0]?.status === "running",
        );
        assert.equal(native.sends.at(-1)?.contextContinuationOfRunId, originalRunId);
        assert.equal(snapshot.rounds[0]!.deliveries[0]!.contextContinuationOfRunId, originalRunId);
        assert.deepEqual(native.sends.at(-1)?.catalogContextRevision, revision);
      }
      assert.equal(native.sends.length, 3);
    }).pipe(Effect.scoped),
);

it.effect.each(["local", "remote"] as const)(
  "keeps a %s member's first context through later invitations, then resets next round",
  (location) =>
    Effect.gen(function* () {
      const hostId = EnvironmentId.make("invitation-participant");
      const native = fixture(false, { environmentId: hostId });
      const host = Context.get(yield* Layer.build(native.layer), GroupChatService.GroupChatService);
      const coordinator = fixture(false, {
        request: (_environmentId, input) => host.peer(EnvironmentId.make("coordinator"), input),
      });
      const groups =
        location === "local"
          ? host
          : Context.get(yield* Layer.build(coordinator.layer), GroupChatService.GroupChatService);
      const created = yield* groups.create({
        name: "Invitation context",
        workflow: "team",
        members: [
          { threadId: ux, alias: "UX" },
          {
            threadId: ui,
            alias: "UI",
            ...(location === "remote" ? { environmentId: hostId } : {}),
          },
        ],
        clientRequestId: "create",
      });
      yield* groups.send({
        groupId: created.group.id,
        message: "@UX @UI discuss this",
        clientRequestId: "send",
      });
      const started = yield* until(groups, created.group.id, (snapshot) =>
        snapshot.rounds[0]!.deliveries.every((delivery) => delivery.status === "running"),
      );
      const original = started.rounds[0]!.deliveries.find(
        (delivery) =>
          delivery.memberId === created.members.find((member) => member.alias === "UI")!.id,
      )!;
      native.finish(ui, "Initial review");
      yield* groups.reconcile();
      yield* groups.ask(ux, {
        targetMemberId: "@UI",
        message: "Review this addition",
        clientRequestId: "ask",
      });
      (location === "local" ? native : coordinator).finish(ux, "Additional detail");
      yield* groups.reconcile();
      const invited = yield* until(groups, created.group.id, (snapshot) =>
        snapshot.rounds[0]!.deliveries.some(
          (delivery) => delivery.stage === "handoff" && delivery.status === "running",
        ),
      );
      assert.equal(native.sends.at(-1)?.contextContinuationOfRunId, original.runId);
      assert.equal(
        invited.rounds[0]!.deliveries.at(-1)?.contextContinuationOfRunId,
        original.runId,
      );
      native.finish(ui, "Final review");
      yield* groups.reconcile();
      yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      yield* groups.send({
        groupId: created.group.id,
        message: "@UI next task",
        clientRequestId: "next",
      });
      yield* until(groups, created.group.id, (snapshot) =>
        snapshot.rounds.some(
          (round) => round.status === "active" && round.deliveries[0]?.status === "running",
        ),
      );
      assert.isUndefined(native.sends.at(-1)?.contextContinuationOfRunId);
    }).pipe(Effect.scoped),
);

it.effect(
  "accepts only a structured named handoff and includes the completed sender response",
  () => {
    const native = fixture();
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        name: "Design",
        workflow: "team",
        members: [
          { threadId: ux, alias: "UX" },
          { threadId: ui, alias: "UI" },
        ],
        clientRequestId: "create",
      });
      yield* groups.send({
        groupId: created.group.id,
        message: "@UX plan this",
        clientRequestId: "send",
      });
      yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.deliveries[0]?.status === "running",
      );
      const bypass = yield* groups.assertDirectSendAllowed(ux, ui).pipe(Effect.result);
      assert.equal(bypass._tag, "Failure");
      const handoff = yield* groups.ask(ux, {
        targetMemberId: "@UI",
        message: "Check the visual hierarchy",
        clientRequestId: "ask",
      });
      assert.equal(native.sends.length, 1);
      native.finish(ux, "Here is my plan. @UI is mentioned in prose as well.");
      yield* groups.reconcile();
      yield* until(
        groups,
        created.group.id,
        (snapshot) =>
          snapshot.rounds[0]?.deliveries.some(
            (delivery) => delivery.id === handoff.deliveryId && delivery.status === "running",
          ) === true,
      );
      assert.equal(native.sends.length, 2);
      assert.equal(native.sends[1]?.threadId, ui);
      assert.ok(native.sends[1]?.text.includes("Here is my plan"));
      yield* groups.ask(ux, {
        targetMemberId: "@UI",
        message: "Check the visual hierarchy",
        clientRequestId: "ask",
      });
      assert.equal(native.sends.length, 2);
      const cycle = yield* groups
        .ask(ui, { targetMemberId: "@UX", message: "Ask again", clientRequestId: "cycle" })
        .pipe(Effect.result);
      assert.equal(cycle._tag, "Failure");
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("reports a missing relevance capability as unavailable instead of silence", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const created = yield* groups.create({
      name: "Design",
      workflow: "team",
      members: [{ threadId: ux, alias: "UX" }],
      clientRequestId: "create",
    });
    yield* groups.send({
      groupId: created.group.id,
      message: "Any useful thoughts?",
      clientRequestId: "send",
    });
    const completed = yield* until(
      groups,
      created.group.id,
      (snapshot) => snapshot.rounds[0]?.status === "completed",
    );
    assert.equal(completed.rounds[0]?.deliveries[0]?.status, "unavailable");
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});

it.effect(
  "uses each member's selected model to decide relevance and preserves deliberate silence",
  () => {
    const selections: Array<
      Parameters<NonNullable<ProviderTextGeneration["assessGroupRelevance"]>>[0]
    > = [];
    const native = fixture(true, {
      relevance: (input) =>
        Effect.sync(() => {
          selections.push(input);
          return {
            decision: input.role.startsWith("UX:") ? ("silent" as const) : ("reply" as const),
          };
        }),
    });
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        name: "Self selection",
        workflow: "team",
        members: [
          { threadId: ux, alias: "UX", role: "research" },
          { threadId: ui, alias: "UI", role: "visuals" },
        ],
        clientRequestId: "create",
      });
      yield* groups.send({
        groupId: created.group.id,
        message: "Improve the colors",
        clientRequestId: "send",
      });
      const completed = yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      assert.equal(selections.length, 2);
      assert.ok(
        selections.every(
          (selection) =>
            selection.modelSelection.model === "gpt-5" &&
            selection.modelSelection.instanceId === "codex",
        ),
      );
      assert.deepEqual(
        native.sends.map((send) => send.threadId),
        [ui],
      );
      assert.deepEqual(
        completed.rounds[0]?.deliveries.map((delivery) => delivery.status),
        ["silent", "completed"],
      );
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("requires a scoped lead when two devices contain the same native thread id", () =>
  Effect.gen(function* () {
    const hostId = EnvironmentId.make("participant-host");
    const participant = fixture(true, { environmentId: hostId });
    const participantContext = yield* Layer.build(participant.layer);
    const host = Context.get(participantContext, GroupChatService.GroupChatService);
    const coordinator = fixture(true, {
      request: (_environment, input) => host.peer(EnvironmentId.make("coordinator"), input),
    });
    const coordinatorContext = yield* Layer.build(coordinator.layer);
    const groups = Context.get(coordinatorContext, GroupChatService.GroupChatService);
    const input = {
      name: "Scoped builder",
      workflow: "build-review" as const,
      members: [
        { threadId: ux, alias: "Local" },
        { threadId: ux, alias: "Remote", environmentId: hostId },
      ],
      leadThreadId: ux,
      clientRequestId: "scoped-lead",
    };
    assert.equal((yield* groups.create(input).pipe(Effect.result))._tag, "Failure");
    const created = yield* groups.create({ ...input, leadEnvironmentId: hostId });
    assert.equal(created.members.length, 2);
    const lead = created.members.find((member) => member.id === created.group.leadMemberId);
    assert.equal(lead?.environmentId, hostId);
    assert.equal(lead?.alias, "Remote");
  }).pipe(Effect.scoped),
);

it.effect(
  "continues a cross-host delivery after a lost acknowledgement without another native turn",
  () =>
    Effect.gen(function* () {
      const hostId = EnvironmentId.make("participant-host");
      const participant = fixture(true, { environmentId: hostId });
      const participantContext = yield* Layer.build(participant.layer);
      const host = Context.get(participantContext, GroupChatService.GroupChatService);
      let loseAcknowledgement = true;
      const coordinator = fixture(false, {
        request: (_environmentId, input) =>
          host.peer(EnvironmentId.make("coordinator"), input).pipe(
            Effect.flatMap((response) => {
              if (input.type === "dispatch" && loseAcknowledgement) {
                loseAcknowledgement = false;
                return Effect.fail(
                  new GroupChatError({
                    code: "dispatch",
                    message: "Peer disconnected after accepting the native turn",
                  }),
                );
              }
              return Effect.succeed(response);
            }),
          ),
      });
      const coordinatorContext = yield* Layer.build(coordinator.layer);
      const groups = Context.get(coordinatorContext, GroupChatService.GroupChatService);
      const created = yield* groups.create({
        name: "Across devices",
        workflow: "team",
        members: [{ threadId: ux, alias: "Remote", environmentId: hostId }],
        clientRequestId: "remote-create",
      });
      yield* groups.send({
        groupId: created.group.id,
        message: "@everyone reply remotely",
        clientRequestId: "remote-send",
      });
      yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.deliveries[0]?.error !== null,
      );
      assert.equal(participant.sends.length, 1);
      yield* groups.reconcile();
      const completed = yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      assert.equal(participant.sends.length, 1);
      assert.equal(coordinator.sends.length, 0);
      assert.equal(completed.rounds[0]?.deliveries[0]?.status, "completed");
      assert.ok(
        completed.messages.some(
          (message) => message.kind === "assistant" && message.text.includes("Reply 1"),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect.each(["build-review", "council"] as const)(
  "executes %s in order and keeps each member's original context for later stages",
  (workflow) => {
    const native = fixture(true);
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const created = yield* groups.create({
        name: "Build",
        workflow,
        members: [
          { threadId: ux, alias: "Builder" },
          { threadId: ui, alias: "Reviewer" },
        ],
        clientRequestId: "create",
      });
      yield* groups.send({
        groupId: created.group.id,
        message: "Implement the feature",
        clientRequestId: "send",
      });
      const completed = yield* until(
        groups,
        created.group.id,
        (snapshot) => snapshot.rounds[0]?.status === "completed",
      );
      assert.deepEqual(
        native.sends.map((send) => send.threadId),
        workflow === "build-review" ? [ux, ui, ux] : [ux, ui, ui, ux],
      );
      assert.deepEqual(
        completed.rounds[0]?.deliveries.map((delivery) => delivery.stage),
        workflow === "build-review"
          ? ["initial", "review", "fix"]
          : ["initial", "initial", "critique", "synthesis"],
      );
      assert.ok(native.sends[workflow === "build-review" ? 1 : 2]?.text.includes("Reply 1"));
      assert.ok(native.sends[2]?.text.includes("Reply 2"));
      for (const member of completed.members) {
        const original = completed.rounds[0]!.deliveries.find(
          (delivery) => delivery.memberId === member.id,
        );
        const sends = native.sends.filter((send) => send.threadId === member.threadId);
        assert.isUndefined(sends[0]?.contextContinuationOfRunId);
        for (const later of sends.slice(1))
          assert.equal(later.contextContinuationOfRunId, original!.runId);
      }
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect(
  "reserves remote original chats exclusively and dispatches a retried peer message once",
  () => {
    const native = fixture(true);
    return Effect.gen(function* () {
      const groups = yield* GroupChatService.GroupChatService;
      const caller = EnvironmentId.make("remote-owner");
      const member = {
        groupId: GroupId.make("remote-group"),
        memberId: "remote-member",
        threadId: ux,
      };
      yield* groups.peer(caller, { type: "reserve", ...member });
      const conflict = yield* groups
        .create({
          name: "Other group",
          workflow: "team",
          members: [{ threadId: ux, alias: "UX" }],
          clientRequestId: "conflict",
        })
        .pipe(Effect.result);
      assert.equal(conflict._tag, "Failure");
      const request = {
        type: "dispatch" as const,
        ...member,
        deliveryId: "remote-delivery",
        prompt: "Answer this shared message",
        handoff: false,
      };
      const first = yield* groups.peer(caller, request);
      const replay = yield* groups.peer(caller, request);
      assert.deepEqual(replay, first);
      assert.equal(native.sends.length, 1);
      const output = yield* groups.peer(caller, {
        type: "read",
        ...member,
        deliveryId: request.deliveryId,
      });
      assert.equal(output.type, "run");
      if (output.type === "run") {
        assert.equal(output.status, "completed");
        assert.ok(output.text.includes("Reply 1"));
      }
      const forged = yield* groups
        .peer(EnvironmentId.make("other-host"), request)
        .pipe(Effect.result);
      assert.equal(forged._tag, "Failure");
      yield* groups.peer(caller, { type: "release", ...member });
      yield* groups.create({
        name: "New group",
        workflow: "team",
        members: [{ threadId: ux, alias: "UX" }],
        clientRequestId: "after-release",
      });
    }).pipe(Effect.provide(native.layer));
  },
);

it.effect("records a remote stop before dispatch so a delayed request cannot start work", () => {
  const native = fixture();
  return Effect.gen(function* () {
    const groups = yield* GroupChatService.GroupChatService;
    const caller = EnvironmentId.make("remote-owner");
    const member = {
      groupId: GroupId.make("remote-group"),
      memberId: "remote-member",
      threadId: ux,
    };
    yield* groups.peer(caller, { type: "reserve", ...member });
    yield* groups.peer(caller, { type: "interrupt", ...member, deliveryId: "late-delivery" });
    const late = yield* groups
      .peer(caller, {
        type: "dispatch",
        ...member,
        deliveryId: "late-delivery",
        prompt: "Arrived after stop",
        handoff: false,
      })
      .pipe(Effect.result);
    assert.equal(late._tag, "Failure");
    assert.equal(native.sends.length, 0);
  }).pipe(Effect.provide(native.layer));
});
