import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  accountFailoverHistory,
  accountQuotaState,
  eligibleFailoverAccount,
} from "./accountFailoverPolicy.ts";

const now = Date.parse("2026-10-25T12:00:00Z");
const failedAt = now - 1000;

function account(id: string, usedPercent = 0): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("fixture"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    runtimePaths: { homePath: `/accounts/${id}`, shadowHomePath: null },
    models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    accountFailover: { supported: true, reason: "Fixture permits account failover." },
    usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      credentialFingerprint: id,
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 10000)),
        },
      ],
    },
  };
}

describe("account quota evidence", () => {
  it("requires a fresh successful probe and a future exhausted window", () => {
    const source = account("source", 100);
    expect(accountQuotaState(source, now, failedAt)).toBe("exhausted");
    expect(
      accountQuotaState(
        {
          ...source,
          usageLimits: {
            ...source.usageLimits!,
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(failedAt - 1)),
          },
        },
        now,
        failedAt,
      ),
    ).toBe("unknown");
    expect(
      accountQuotaState(
        {
          ...source,
          usageLimits: { ...source.usageLimits!, unavailable: { reason: "probeFailed" } },
        },
        now,
        failedAt,
      ),
    ).toBe("unknown");
    expect(accountQuotaState(source, now + 20000, failedAt)).toBe("unknown");
    expect(accountQuotaState(source, now - 1, failedAt)).toBe("unknown");
  });

  it("does not interpret an empty, unknown or partially exhausted pool as available", () => {
    const source = account("source");
    expect(
      accountQuotaState(
        { ...source, usageLimits: { ...source.usageLimits!, windows: [] } },
        now,
        failedAt,
      ),
    ).toBe("unknown");
    expect(accountQuotaState({ ...source, usageLimits: undefined }, now, failedAt)).toBe("unknown");
    expect(
      accountQuotaState(
        {
          ...source,
          usageLimits: {
            ...source.usageLimits!,
            windows: [
              source.usageLimits!.windows[0]!,
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 100,
                resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1000)),
              },
            ],
          },
        },
        now,
        failedAt,
      ),
    ).toBe("exhausted");
  });
});

describe("failover account admission", () => {
  it("accepts only a permitted, independently authenticated account on the same model and driver", () => {
    const source = account("source", 100);
    const target = account("target");
    const eligible = (candidate: ServerProvider) =>
      eligibleFailoverAccount(source, candidate, "model", now, failedAt);
    expect(eligible(target)).toBe(true);
    expect(eligible({ ...target, accountFailover: undefined })).toBe(false);
    expect(
      eligible({ ...target, accountFailover: { supported: false, reason: "Manual only" } }),
    ).toBe(false);
    expect(eligible({ ...target, driver: ProviderDriverKind.make("other") })).toBe(false);
    expect(eligible({ ...target, models: [] })).toBe(false);
    expect(eligible({ ...target, enabled: false })).toBe(false);
    expect(eligible({ ...target, auth: { status: "unknown" } })).toBe(false);
    expect(eligible({ ...target, runtimePaths: source.runtimePaths! })).toBe(false);
    expect(eligible({ ...target, auth: source.auth })).toBe(false);
    expect(
      eligible({
        ...target,
        usageLimits: { ...target.usageLimits!, credentialFingerprint: "source" },
      }),
    ).toBe(false);
    expect(
      eligibleFailoverAccount(
        { ...source, accountFailover: undefined },
        target,
        "model",
        now,
        failedAt,
      ),
    ).toBe(false);
  });
});

it("persists the attempted account set across a continuation chain and starts fresh for a user turn", () => {
  const origin = {
    id: RunId.make("first"),
    providerInstanceId: ProviderInstanceId.make("source"),
  } as OrchestrationV2Run;
  const next = {
    id: RunId.make("second"),
    providerInstanceId: ProviderInstanceId.make("target"),
    accountFailoverOriginRunId: origin.id,
  } as OrchestrationV2Run;
  const history = accountFailoverHistory([origin, next], next);
  expect(history.originRunId).toBe(origin.id);
  expect([...history.attemptedInstanceIds]).toEqual(["source", "target"]);
  const manual = {
    id: RunId.make("manual"),
    providerInstanceId: ProviderInstanceId.make("target"),
  } as OrchestrationV2Run;
  expect([...accountFailoverHistory([origin, next, manual], manual).attemptedInstanceIds]).toEqual([
    "target",
  ]);
});
