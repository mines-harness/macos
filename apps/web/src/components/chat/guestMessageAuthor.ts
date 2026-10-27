export function guestMessageAuthorName(
  message: { readonly guestName?: string | undefined; readonly guestId?: string | undefined },
  share: { readonly guestName: string | null },
): string {
  return message.guestName ?? (message.guestId ? "Guest" : (share.guestName ?? "Guest"));
}
