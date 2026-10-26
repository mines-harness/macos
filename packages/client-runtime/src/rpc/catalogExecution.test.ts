import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { GroupId } from "@t3tools/contracts/groupChat";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { MinesCatalog } from "../catalog/index.ts";
import {
  captureCatalogExecution,
  catalogBytesToBase64,
  registerCatalogExecutionHost,
  registerCatalogExecutionSource,
  RpcCatalogExecution,
} from "../catalog/execution.ts";
import { minesAccountIdAtom, minesCatalogIdentityAtom } from "../catalog/identity.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { requestGuarded, RpcPermissionGuard, type EnvironmentRpcInput } from "./client.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("host"),
  label: "This computer",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const methods = [
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  WS_METHODS.groupsSend,
] as const;
type Method = (typeof methods)[number];

const inputs: Record<Method, EnvironmentRpcInput<Method>> = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("send"),
    threadId: ThreadId.make("mine"),
    messageId: MessageId.make("message"),
    text: "Use the project context",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  },
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: {
    commandId: CommandId.make("launch"),
    projectId: ProjectId.make("project"),
    title: "New mine",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: "Use the project context", attachments: [] },
  },
  [WS_METHODS.groupsSend]: {
    groupId: GroupId.make("group"),
    message: "Use the project context",
    clientRequestId: "send",
  },
};

const setup = Effect.fn("CatalogExecutionTest.setup")(function* () {
  const registry = AtomRegistry.make();
  const catalog = new MinesCatalog({ createId: () => "project" });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      registry.dispose();
      catalog.destroy();
    }),
  );
  registry.set(minesAccountIdAtom, "account-a");
  registry.set(minesCatalogIdentityAtom, { ready: true, accountId: "account-a", readToken: null });
  catalog.createSection("Instructions at send");
  const stored: Uint8Array[] = [];
  const unregisterSource = registerCatalogExecutionSource(
    registry,
    "account-a",
    catalog,
    async () => {
      stored.push(catalog.encodeUpdate());
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(unregisterSource));
  const started = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const unregisterHost = registerCatalogExecutionHost(registry, target.environmentId, async () => {
    started.resolve();
    await acknowledge.promise;
  });
  yield* Effect.addFinalizer(() => Effect.sync(unregisterHost));
  const received: unknown[] = [];
  const client = Object.fromEntries(
    methods.map((method) => [
      method,
      (input: unknown) =>
        Effect.sync(() => {
          received.push(input);
        }),
    ]),
  ) as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => client.subscribeServerConfig({}),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const send = (method: Method) =>
    requestGuarded(method, inputs[method]).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
      Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
      Effect.provideService(RpcCatalogExecution, {
        capture: () => captureCatalogExecution(registry),
      }),
    );
  return { registry, catalog, stored, started, acknowledge, received, send };
});

describe("catalog execution acknowledgment", () => {
  it.effect.each(methods)("waits for the captured revision before %s", (method) =>
    Effect.gen(function* () {
      const h = yield* setup();
      const captured = catalogBytesToBase64(h.catalog.encodeStateVector());
      const fiber = yield* h.send(method).pipe(Effect.forkChild);
      yield* Effect.promise(() => h.started.promise);
      expect(h.stored).toHaveLength(1);
      expect(h.received).toEqual([]);
      h.catalog.rename("section:project", "An edit made after Send");
      h.acknowledge.resolve();
      yield* Fiber.join(fiber);
      expect(h.received).toEqual([
        expect.objectContaining({
          catalogContextRevision: { accountId: "account-a", stateVector: captured },
        }),
      ]);
      expect(catalogBytesToBase64(h.catalog.encodeStateVector())).not.toBe(captured);
    }),
  );

  it.effect("does not dispatch when synchronization fails", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const fiber = yield* h.send(WS_METHODS.groupsSend).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => h.started.promise);
      h.acknowledge.reject(new Error("The direct connection was lost."));
      expect((yield* Fiber.join(fiber)).message).toContain("direct connection was lost");
      expect(h.received).toEqual([]);
    }),
  );

  it.effect("does not dispatch after the account changes during acknowledgment", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const fiber = yield* h.send(WS_METHODS.groupsSend).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => h.started.promise);
      h.registry.set(minesAccountIdAtom, "account-b");
      h.registry.set(minesCatalogIdentityAtom, {
        ready: true,
        accountId: "account-b",
        readToken: null,
      });
      h.acknowledge.resolve();
      expect((yield* Fiber.join(fiber)).message).toContain("not ready for this account");
      expect(h.received).toEqual([]);
    }),
  );
});
