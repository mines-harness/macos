import type { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      compactIds: "1",
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadHistoryPage(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadHistoryPage({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
  });
});

export const fetchEnvironmentThreadBodyRange = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadBodyRange",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly field: "text" | "markdown";
  readonly before: number;
  readonly revision: string;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}) {
  const endpoint = {
    params: { threadId: input.threadId, itemId: input.itemId },
    query: { field: input.field, before: input.before, revision: input.revision },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadBodyRange(endpoint),
    timeoutMs: DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadBodyRange({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) }),
  });
});
