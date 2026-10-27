import type { ThreadGuestShare } from "@t3tools/contracts";

export function guestShareLinkAvailable(
  share: ThreadGuestShare | null | undefined,
  now: number,
): boolean {
  if (!share) return false;
  const useCount = share.useCount ?? share.guests?.length ?? (share.guestName ? 1 : 0);
  return Date.parse(share.expiresAt) > now && useCount < (share.maxGuests ?? 1);
}
