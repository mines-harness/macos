import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export const mineTransferDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mine-transfer:dialog-thread"),
);

export function openMineTransferDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(mineTransferDialogThreadAtom, threadRef);
}
