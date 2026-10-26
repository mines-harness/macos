import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { environmentPresentations } from "../../state/presentation";
import { mineTransferCommands } from "../../state/mineTransfer";

export const canTransferMineAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.environment.capabilities
        .mineTransfer === true &&
      get(mineTransferCommands.prepare.permissionAtom(environmentId)) &&
      get(mineTransferCommands.readChunk.permissionAtom(environmentId)) &&
      get(mineTransferCommands.finalize.permissionAtom(environmentId)),
  ).pipe(Atom.withLabel(`mine-transfer:available:${environmentId}`)),
);
