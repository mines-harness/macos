import { guestShareGuests, guestSharePermission } from "@t3tools/contracts";
import type {
  GuestSessionId,
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  ServerProvider,
} from "@t3tools/contracts";

/** The thread's model as the owner's composer labels it, from the configured providers. */
export function guestThreadModel(
  selection: OrchestrationV2AppThread["modelSelection"],
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): GuestThreadModel {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return {
    driver: provider?.driver ?? null,
    name: model?.name ?? selection.model,
    ...(model?.shortName === undefined ? {} : { shortName: model.shortName }),
    ...(model?.subProvider === undefined ? {} : { subProvider: model.subProvider }),
  };
}

/** The share as its guest sees it, or null before the guest has joined. */
export function guestShareView(
  thread: OrchestrationV2AppThread,
  model: GuestThreadModel,
  guestId?: GuestSessionId,
): GuestShareView | null {
  const share = thread.guestShare;
  if (!share) return null;
  const guests = guestShareGuests(share);
  const guest = guests.find((candidate) => candidate.id === guestId);
  const guestName = guestId === undefined ? share.guestName : guest?.name;
  if (!guestName) return null;
  return {
    shareId: share.id,
    title: thread.title,
    guestName,
    permission: guestSharePermission(share),
    ...(guestId === undefined ? {} : { guestId }),
    guests: guests.map(({ id, name, joinedAt }) => ({ id, name, joinedAt })),
    expiresAt: share.expiresAt,
    messages: share.messages,
    model,
  };
}

export function guestVisibleThread(thread: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const { guestBannedIps: _bannedIps, ...visible } = thread;
  return {
    ...visible,
    ...(thread.guestShare == null
      ? {}
      : {
          guestShare: {
            ...thread.guestShare,
            guests: guestShareGuests(thread.guestShare).map(
              ({ ipAddress: _ip, ...guest }) => guest,
            ),
          },
        }),
  };
}
