import {
  CommandId,
  MessageId,
  ThreadId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderSwitch from "./ProviderSwitchService.ts";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import {
  MAX_ACCOUNT_FAILOVER_ATTEMPTS,
  accountFailoverHistory,
  accountQuotaState,
  eligibleFailoverAccount,
} from "./accountFailoverPolicy.ts";

export class AccountFailoverError extends Schema.TaggedError<AccountFailoverError>()(
  "AccountFailoverError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message() {
    return "The account continuation could not be confirmed.";
  }
}

export class AccountFailoverService extends Context.Service<
  AccountFailoverService,
  {
    readonly recover: (
      candidate: ProjectionLimitRecoveryCandidate,
    ) => Effect.Effect<"not_applicable" | "pool_exhausted" | "continued", AccountFailoverError>;
  }
>()("mines/orchestration-v2/AccountFailoverService") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const switches = yield* ProviderSwitch.ProviderSwitchServiceV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const lane = yield* Semaphore.make(1);

  const recover = Effect.fn("AccountFailoverService.recover")(
    function* (candidate: ProjectionLimitRecoveryCandidate) {
      const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (
        candidate.status !== "failed" ||
        candidate.lastErrorClass !== "usage_limit" ||
        !candidate.latestRunId ||
        candidate.archivedAt !== null ||
        candidate.settledOverride === "settled" ||
        candidate.pendingRuntimeRequest !== null ||
        (candidate.snoozedUntil != null &&
          DateTime.toEpochMillis(candidate.snoozedUntil) > startedAtMs)
      )
        return "not_applicable" as const;

      const preferences = yield* settings.getSettings;
      const projection = yield* threads.getThreadRecords(candidate.id, [
        "runs",
        "providerThreads",
        "providerSessions",
      ]);
      const sourceRun = projection.runs.find((run) => run.id === candidate.latestRunId);
      const sourceId = projection.thread.modelSelection.instanceId;
      if (
        !sourceRun ||
        sourceRun.status !== "failed" ||
        sourceRun.providerInstanceId !== sourceId ||
        !modelSelectionsEqual(projection.thread.modelSelection, sourceRun.modelSelection) ||
        preferences.providerInstances[sourceId]?.quotaFailoverPriority === undefined
      )
        return "not_applicable" as const;

      const sourceInstance = yield* registry.getInstance(sourceId);
      if (!sourceInstance?.enabled) return "not_applicable" as const;
      const cached = yield* sourceInstance.snapshot.getSnapshot;
      if (cached.accountFailover?.supported !== true) return "not_applicable" as const;
      const source = yield* sourceInstance.snapshot.refresh;
      const failedAtMs = DateTime.toEpochMillis(sourceRun.completedAt ?? candidate.updatedAt);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (
        source.accountFailover?.supported !== true ||
        accountQuotaState(source, nowMs, failedAtMs) !== "exhausted"
      )
        return "not_applicable" as const;
      const history = accountFailoverHistory(projection.runs, sourceRun);
      if (history.attemptedInstanceIds.size >= MAX_ACCOUNT_FAILOVER_ATTEMPTS)
        return "pool_exhausted" as const;

      const sourceHome = source.runtimePaths?.homePath;
      if (!sourceHome) return "not_applicable" as const;
      const sourceRealHome = yield* fileSystem.realPath(sourceHome).pipe(Effect.option);
      if (Option.isNone(sourceRealHome)) return "not_applicable" as const;

      const candidates = (yield* registry.listInstances)
        .filter(
          (instance) =>
            instance.enabled &&
            instance.driverKind === source.driver &&
            !history.attemptedInstanceIds.has(instance.instanceId) &&
            preferences.providerInstances[instance.instanceId]?.quotaFailoverPriority !==
              undefined &&
            resolveProjectProviderInstanceEnabled(
              preferences,
              projection.thread.projectId,
              instance.instanceId,
            ),
        )
        .toSorted(
          (left, right) =>
            preferences.providerInstances[left.instanceId]!.quotaFailoverPriority! -
              preferences.providerInstances[right.instanceId]!.quotaFailoverPriority! ||
            left.instanceId.localeCompare(right.instanceId),
        )
        .slice(0, MAX_ACCOUNT_FAILOVER_ATTEMPTS - history.attemptedInstanceIds.size);

      for (const instance of candidates) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.accountFailover?.supported !== true) continue;
        const target = yield* instance.snapshot.refresh;
        const checkedNow = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          !eligibleFailoverAccount(
            source,
            target,
            sourceRun.modelSelection.model,
            checkedNow,
            failedAtMs,
          )
        )
          continue;
        const targetHome = yield* fileSystem
          .realPath(target.runtimePaths!.homePath)
          .pipe(Effect.option);
        if (Option.isNone(targetHome) || targetHome.value === sourceRealHome.value) continue;
        const modelSelection = { ...sourceRun.modelSelection, instanceId: instance.instanceId };
        const plan = yield* switches
          .plan({ projection, targetModelSelection: modelSelection })
          .pipe(Effect.result);
        if (plan._tag === "Failure") continue;
        const identity = `account-failover:${candidate.id}:${sourceRun.id}:${instance.instanceId}`;
        // A committed dispatch may outlive its caller; never try another account after dispatch.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(identity),
          messageId: MessageId.make(identity),
          threadId: candidate.id,
          modelSelection,
          accountFailoverOfRunId: sourceRun.id,
          text: "Continue from the last confirmed state. Check existing changes and completed tool results before doing more work; do not repeat completed actions.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        });
        return "continued" as const;
      }
      return "pool_exhausted" as const;
    },
    (effect, candidate) =>
      lane
        .withPermits(1)(effect)
        .pipe(
          Effect.mapError((cause) => new AccountFailoverError({ threadId: candidate.id, cause })),
        ),
  );
  return AccountFailoverService.of({ recover });
});

export const layer = Layer.effect(AccountFailoverService, make);
