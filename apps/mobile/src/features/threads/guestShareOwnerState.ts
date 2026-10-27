import type { GuestShareCreateResult, ThreadGuestShare } from "@t3tools/contracts";

export interface GuestShareOwnerSnapshot {
  readonly loaded: boolean;
  readonly share: ThreadGuestShare | null;
  readonly error?: string | null;
}

export interface GuestShareCreation {
  readonly result: GuestShareCreateResult;
  readonly previousShareId: string | null;
  readonly synchronized: boolean;
}

export function guestShareOwnerView(
  snapshot: GuestShareOwnerSnapshot,
  creation: GuestShareCreation | null,
) {
  if (creation !== null && snapshot.loaded) {
    const shareId = snapshot.share?.id ?? null;
    if (shareId === creation.result.share.id) {
      if (!creation.synchronized) creation = { ...creation, synchronized: true };
    } else if (creation.synchronized || shareId !== creation.previousShareId) {
      creation = null;
    }
  }
  const share =
    creation !== null && !creation.synchronized ? creation.result.share : snapshot.share;
  const useCount = share?.useCount ?? share?.guests?.length ?? (share?.guestName == null ? 0 : 1);
  const exhausted = share !== null && useCount >= (share.maxGuests ?? 1);
  return {
    creation,
    share,
    canCreate: snapshot.loaded && (creation === null || exhausted),
    url: creation !== null && !exhausted ? creation.result.url : null,
    exhausted,
  };
}
