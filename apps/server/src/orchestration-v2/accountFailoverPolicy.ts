import type { OrchestrationV2Run, ServerProvider } from "@t3tools/contracts";

export const MAX_ACCOUNT_FAILOVER_ATTEMPTS = 8;
const MAX_QUOTA_AGE_MS = 60_000;

export function accountQuotaState(
  account: ServerProvider,
  nowMs: number,
  failedAtMs: number,
): "available" | "exhausted" | "unknown" {
  const limits = account.usageLimits;
  if (!limits || limits.unavailable || limits.windows.length === 0) return "unknown";
  const checkedAtMs = Date.parse(limits.checkedAt);
  if (
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs < failedAtMs ||
    checkedAtMs > nowMs ||
    nowMs - checkedAtMs > MAX_QUOTA_AGE_MS ||
    limits.windows.some(
      (window) =>
        window.resetsAt === undefined ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) <= nowMs,
    )
  )
    return "unknown";
  return limits.windows.some((window) => window.usedPercent >= 100) ? "exhausted" : "available";
}

export function eligibleFailoverAccount(
  source: ServerProvider,
  target: ServerProvider,
  model: string,
  nowMs: number,
  failedAtMs: number,
): boolean {
  const sourceFingerprint = source.usageLimits?.credentialFingerprint;
  const targetFingerprint = target.usageLimits?.credentialFingerprint;
  const differentAccounts =
    source.auth.email && target.auth.email
      ? source.auth.email.toLowerCase() !== target.auth.email.toLowerCase()
      : source.auth.profileId !== undefined &&
        target.auth.profileId !== undefined &&
        source.auth.profileId !== target.auth.profileId;
  return (
    source.accountFailover?.supported === true &&
    target.accountFailover?.supported === true &&
    source.driver === target.driver &&
    source.instanceId !== target.instanceId &&
    target.enabled &&
    target.installed &&
    target.status === "ready" &&
    target.availability !== "unavailable" &&
    source.auth.status === "authenticated" &&
    target.auth.status === "authenticated" &&
    sourceFingerprint !== undefined &&
    targetFingerprint !== undefined &&
    sourceFingerprint !== targetFingerprint &&
    differentAccounts &&
    source.runtimePaths !== undefined &&
    target.runtimePaths !== undefined &&
    source.runtimePaths.homePath !== target.runtimePaths.homePath &&
    target.models.some((candidate) => candidate.slug === model) &&
    accountQuotaState(source, nowMs, failedAtMs) === "exhausted" &&
    accountQuotaState(target, nowMs, failedAtMs) === "available"
  );
}

export function accountFailoverHistory(
  runs: ReadonlyArray<OrchestrationV2Run>,
  source: OrchestrationV2Run,
) {
  const originRunId = source.accountFailoverOriginRunId ?? source.id;
  return {
    originRunId,
    attemptedInstanceIds: new Set(
      runs
        .filter((run) => run.id === originRunId || run.accountFailoverOriginRunId === originRunId)
        .map((run) => run.providerInstanceId),
    ),
  };
}
