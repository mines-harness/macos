import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import * as AccountFailover from "./AccountFailoverService.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread");
const driver = ProviderDriverKind.make("fixture");
const sourceId = ProviderInstanceId.make("source");
const sourceRunId = RunId.make("run");

function snapshot(id: string, now: DateTime.Utc, used: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver,
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: DateTime.formatIso(now),
    models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
    runtimePaths: { homePath: `/accounts/${id}`, shadowHomePath: null },
    accountFailover: { supported: true, reason: "Fixture policy" },
    usageLimits: {
      checkedAt: DateTime.formatIso(now),
      credentialFingerprint: id,
      windows: [
        {
          id: "session",
          label: "Session",
          kind: "session",
          usedPercent: used,
          resetsAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        },
      ],
    },
  };
}

function setup(
  now: DateTime.Utc,
  options: {
    readonly unsupported?: boolean;
    readonly dispatchFails?: boolean;
    readonly aliasHomes?: boolean;
  } = {},
) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const planned: Array<string> = [];
  const refreshed: Array<string> = [];
  const source = snapshot("source", now, 100);
  const accounts = [source, snapshot("later", now, 0), snapshot("first", now, 0)];
  const instances = accounts.map(
    (account) =>
      ({
        instanceId: account.instanceId,
        driverKind: driver,
        enabled: true,
        snapshot: {
          getSnapshot: Effect.succeed(
            options.unsupported ? { ...account, accountFailover: undefined } : account,
          ),
          refresh: Effect.sync(() => {
            refreshed.push(account.instanceId);
            return account;
          }),
        },
      }) as ProviderInstance,
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      modelSelection: { instanceId: sourceId, model: "model" },
    },
    runs: [
      {
        id: sourceRunId,
        providerInstanceId: sourceId,
        status: "failed",
        completedAt: now,
        modelSelection: { instanceId: sourceId, model: "model" },
      },
    ],
    providerThreads: [],
    providerSessions: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const candidate: ProjectionLimitRecoveryCandidate = {
    id: threadId,
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: sourceRunId,
    latestRunCompletedAt: now,
    updatedAt: now,
    usageLimitResetAt: null,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      listInstances: Effect.succeed(instances),
      getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          source: { driver, quotaFailoverPriority: 0 },
          first: { driver, quotaFailoverPriority: 1 },
          later: { driver, quotaFailoverPriority: 2 },
        },
      }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (options.dispatchFails)
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Unknown commit outcome",
            });
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ProviderSwitch.ProviderSwitchServiceV2)({
      plan: ({ targetModelSelection }) =>
        Effect.sync(() => {
          planned.push(targetModelSelection.instanceId);
          return {
            instanceChanged: true,
            modelChanged: false,
            targetProviderThreadId: null,
            releaseProviderSessionIds: [],
            transition: { type: "create_with_handoff" as const },
          };
        }),
    }),
    FileSystem.layerNoop({
      realPath: (path) => Effect.succeed(options.aliasHomes ? "/same-account" : path),
    }),
  );
  return {
    candidate,
    dispatched,
    planned,
    refreshed,
    layer: AccountFailover.layer.pipe(Layer.provide(dependencies)),
  };
}

it.effect(
  "uses fresh evidence and configured order, then dispatches one native continuation without replaying the prompt",
  () =>
    Effect.gen(function* () {
      const fixture = setup(yield* DateTime.now);
      const result = yield* AccountFailover.AccountFailoverService.pipe(
        Effect.flatMap((service) => service.recover(fixture.candidate)),
      ).pipe(Effect.provide(fixture.layer));
      assert.equal(result, "continued");
      assert.deepEqual(fixture.planned, ["first"]);
      assert.deepEqual(fixture.refreshed, ["source", "first"]);
      assert.lengthOf(fixture.dispatched, 1);
      const command = fixture.dispatched[0]!;
      assert(command.type === "message.dispatch");
      assert.equal(command.accountFailoverOfRunId, sourceRunId);
      assert.equal(command.modelSelection?.model, "model");
      assert.deepEqual(command.attachments, []);
      assert.include(command.text, "do not repeat completed actions");
    }),
);

it.effect("does not probe or dispatch when the provider policy is unconfirmed", () =>
  Effect.gen(function* () {
    const fixture = setup(yield* DateTime.now, { unsupported: true });
    const result = yield* AccountFailover.AccountFailoverService.pipe(
      Effect.flatMap((service) => service.recover(fixture.candidate)),
    ).pipe(Effect.provide(fixture.layer));
    assert.equal(result, "not_applicable");
    assert.deepEqual(fixture.refreshed, []);
    assert.deepEqual(fixture.dispatched, []);
  }),
);

it.effect("rejects separate-looking paths that resolve to the same account home", () =>
  Effect.gen(function* () {
    const fixture = setup(yield* DateTime.now, { aliasHomes: true });
    const result = yield* AccountFailover.AccountFailoverService.pipe(
      Effect.flatMap((service) => service.recover(fixture.candidate)),
    ).pipe(Effect.provide(fixture.layer));
    assert.equal(result, "pool_exhausted");
    assert.deepEqual(fixture.dispatched, []);
  }),
);

it.effect("does not try another account after an unconfirmed dispatch result", () =>
  Effect.gen(function* () {
    const fixture = setup(yield* DateTime.now, { dispatchFails: true });
    const result = yield* AccountFailover.AccountFailoverService.pipe(
      Effect.flatMap((service) => service.recover(fixture.candidate)),
    ).pipe(Effect.provide(fixture.layer), Effect.result);
    assert.equal(result._tag, "Failure");
    assert.lengthOf(fixture.dispatched, 1);
    assert.deepEqual(fixture.planned, ["first"]);
  }),
);
