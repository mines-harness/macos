import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ThreadGuestShare } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import type { GuestShareOwnerSnapshot } from "./guestShareOwnerState";

const NO_GUEST_SHARE_ATOM = Atom.make<GuestShareOwnerSnapshot>({ loaded: false, share: null });
const NO_BANNED_IPS_ATOM = Atom.make<ReadonlyArray<string>>([]);
const CANNOT_SHARE_ATOM = Atom.make(false);

const guestSharingEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .guestSharingEnabled === true,
  ),
);

export function useGuestSharingEnabled(environmentId: EnvironmentId) {
  return useAtomValue(guestSharingEnabledAtom(environmentId));
}

export function useCanShareWithGuest(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? CANNOT_SHARE_ATOM
      : serverEnvironment.createGuestShare.permissionAtom(environmentId),
  );
}

function guestShareAtom(ref: ScopedThreadRef) {
  let previous: GuestShareOwnerSnapshot = { loaded: false, share: null };
  return Atom.make((get) => {
    const state = get(environmentThreadDetails.stateAtom(ref));
    const next = Option.getOrNull(state.data)?.thread.guestShare ?? null;
    const loaded = state.status === "live";
    const error = Option.getOrNull(state.error);
    // Thread records change during streaming; guest controls only need share updates.
    if (
      loaded !== previous.loaded ||
      error !== (previous.error ?? null) ||
      JSON.stringify(next) !== JSON.stringify(previous.share)
    ) {
      previous = { loaded, share: next, error };
    }
    return previous;
  });
}

export function useThreadGuestShareSnapshot(threadRef: ScopedThreadRef | null) {
  const shareAtom = useMemo(
    () => (threadRef === null ? NO_GUEST_SHARE_ATOM : guestShareAtom(threadRef)),
    [threadRef],
  );
  return useAtomValue(shareAtom);
}

export function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  return useThreadGuestShareSnapshot(threadRef).share;
}

export function useThreadGuestBannedIps(threadRef: ScopedThreadRef | null) {
  const ipsAtom = useMemo(() => {
    if (threadRef === null) return NO_BANNED_IPS_ATOM;
    let previous: ReadonlyArray<string> = [];
    return Atom.make((get) => {
      const next =
        get(environmentThreadDetails.threadAtom(threadRef))?.projection.thread.guestBannedIps ?? [];
      if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
      return previous;
    });
  }, [threadRef]);
  return useAtomValue(ipsAtom);
}

export function useGuestShareExpired(share: ThreadGuestShare | null) {
  const expiresAt = share?.expiresAt;
  const [expiredAt, setExpiredAt] = useState(() =>
    expiresAt && Date.parse(expiresAt) <= Date.now() ? expiresAt : null,
  );
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && expiredAt === expiresAt;
}
