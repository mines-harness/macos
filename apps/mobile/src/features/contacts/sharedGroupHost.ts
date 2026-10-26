import {
  minesAccountEnvironmentIdsAtom,
  minesAccountIdAtom,
} from "@t3tools/client-runtime/catalog";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { PeerConnectionState } from "@t3tools/contracts/minesPeer";
import { appAtomRegistry } from "../../state/atom-registry";

export function sharedGroupHostMatches(
  state: PeerConnectionState | null,
  accountId: string | null,
) {
  return !!accountId && state?.configured === true && state.accountId === accountId;
}

export async function checkSharedGroupHost(
  environmentId: EnvironmentId,
  accountId: string | null,
  load: (target: {
    environmentId: EnvironmentId;
    input: object;
  }) => Promise<AtomCommandResult<PeerConnectionState, unknown>>,
) {
  const current = () => {
    if (
      !accountId ||
      appAtomRegistry.get(minesAccountIdAtom) !== accountId ||
      !appAtomRegistry.get(minesAccountEnvironmentIdsAtom).has(environmentId)
    )
      throw new Error("Choose a computer connected to your current mines account.");
  };
  current();
  const result = await load({ environmentId, input: {} });
  current();
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  if (!sharedGroupHostMatches(result.value, accountId))
    throw new Error("Connect this computer to your current mines account before sharing groups.");
}
