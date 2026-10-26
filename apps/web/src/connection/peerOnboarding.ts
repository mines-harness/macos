import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
} from "@t3tools/client-runtime/catalog";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { connectionAtomRuntime } from "./runtime";
import {
  browserPeerApproval,
  forgetBrowserPeer,
  listBrowserPeerRoutes,
  pairBrowserPeer,
  restoreBrowserPeers,
} from "./peerPairing";

const scheduler = createAtomCommandScheduler();
const common = { scheduler, concurrency: { mode: "serial", key: () => "peer" } } as const;
export const peerClientApproval = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:approval",
  execute: browserPeerApproval,
});
export const peerClientRoutes = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:routes",
  execute: listBrowserPeerRoutes,
});
export const restorePeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:restore",
  execute: restoreBrowserPeers,
});
export const pairPeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:pair",
  execute: Effect.fn("web.peer.pairCommand")(function* (
    input: Parameters<typeof pairBrowserPeer>[0],
    registry: AtomRegistry.AtomRegistry,
  ) {
    const environmentId = yield* pairBrowserPeer(input);
    if (registry.get(minesAccountIdAtom) === input.accountId)
      registry.set(
        minesAccountEnvironmentIdsAtom,
        new Set([...registry.get(minesAccountEnvironmentIdsAtom), environmentId]),
      );
    return environmentId;
  }),
});
export const forgetPeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:forget",
  execute: Effect.fn("web.peer.forgetCommand")(function* (
    input: Parameters<typeof forgetBrowserPeer>[0],
    registry: AtomRegistry.AtomRegistry,
  ) {
    const allowed = yield* forgetBrowserPeer(input);
    if (registry.get(minesAccountIdAtom) === input.accountId)
      registry.set(minesAccountEnvironmentIdsAtom, new Set(allowed));
  }),
});
