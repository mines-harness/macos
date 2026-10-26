import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { encodePeerApproval } from "@t3tools/shared/minesPeerPairing";
import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
} from "@t3tools/client-runtime/catalog";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { connectionAtomRuntime } from "./runtime";
import { loadPeerIdentity, pairPhone, restorePhonePeers } from "./peerPairing";

const scheduler = createAtomCommandScheduler();
const concurrency = { mode: "serial", key: () => "peer" } as const;
export const phoneApprovalCode = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:peer:approval-code",
  scheduler,
  concurrency,
  execute: Effect.fn("mobile.peer.approvalCode")(function* (accountId: string) {
    const identity = yield* loadPeerIdentity(accountId);
    return { device: identity.device, code: encodePeerApproval(identity.device) };
  }),
});
export const restorePeerRoutes = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:peer:restore",
  scheduler,
  concurrency,
  execute: restorePhonePeers,
});
export const connectPeerPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:peer:pair",
  scheduler,
  concurrency,
  execute: Effect.fn("mobile.peer.pairCommand")(function* (
    input: Parameters<typeof pairPhone>[0],
    registry: AtomRegistry.AtomRegistry,
  ) {
    const environmentId = yield* pairPhone(input);
    if (registry.get(minesAccountIdAtom) === input.accountId) {
      registry.set(
        minesAccountEnvironmentIdsAtom,
        new Set([...registry.get(minesAccountEnvironmentIdsAtom), environmentId]),
      );
    }
    return environmentId;
  }),
});
