import { minesAccountEnvironmentIdsAtom } from "@t3tools/client-runtime/catalog";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { indexGroupMemberships } from "../components/groups/groupParticipants.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { groupList } from "./groups";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const groupMembershipsAtom = Atom.make((get) => {
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const ownedEnvironmentIds = get(minesAccountEnvironmentIdsAtom);
  const connectedEnvironmentIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
  return indexGroupMemberships(
    connectedEnvironmentIds.flatMap((environmentId) => {
      if (environmentId !== primaryEnvironmentId && !ownedEnvironmentIds.has(environmentId))
        return [];
      const result = get(groupList({ environmentId, input: {} }));
      const data = Option.getOrNull(AsyncResult.value(result));
      return data ? [{ environmentId, ...data }] : [];
    }),
  );
}).pipe(Atom.withLabel("mines:groups:memberships"));

export function refreshGroupMemberships(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(groupList({ environmentId, input: {} }));
}
