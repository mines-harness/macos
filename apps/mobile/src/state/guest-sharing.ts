import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

export const guestShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null);

export function openGuestShareDialog(threadRef: ScopedThreadRef) {
  appAtomRegistry.set(guestShareDialogThreadAtom, threadRef);
}

export function closeGuestShareDialog() {
  appAtomRegistry.set(guestShareDialogThreadAtom, null);
}
