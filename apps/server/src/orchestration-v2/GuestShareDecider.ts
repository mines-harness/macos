import {
  ChatAttachment,
  GUEST_BANNED_IP_LIMIT,
  GUEST_PENDING_ATTACHMENT_BYTES_LIMIT,
  GUEST_PENDING_MESSAGE_LIMIT,
  GUEST_RESOLVED_MESSAGE_LIMIT,
  guestShareGuests,
  guestSharePermission,
  type GuestMessageAttribution,
  type GuestMessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadGuestMessage,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type GuestShareCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.guest-share.open"
      | "thread.guest-share.redeem"
      | "thread.guest-share.update-ip"
      | "thread.guest-share.close"
      | "thread.guest-share.kick"
      | "thread.guest-share.ban"
      | "thread.guest-share.unban"
      | "thread.guest-message.submit"
      | "thread.guest-message.dismiss";
  }
>;

/** Failures a guest may be told about. Any other dispatch failure reaches them as "rejected". */
export const GUEST_FAILURE = {
  inactive: "This guest link is no longer active.",
  used: "This guest link was already used.",
  banned: "You cannot join this mine.",
  viewer: "This guest link only allows viewing.",
  busy: "Wait for the owner to answer your earlier messages.",
  filesBusy: "Wait for the owner to answer your earlier messages before you attach more files.",
} as const;

const isExpired = (share: ThreadGuestShare, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) >= Date.parse(share.expiresAt);

const attachmentsEqual = Schema.toEquivalence(Schema.Array(ChatAttachment));

const guestShareUseCount = (share: ThreadGuestShare) =>
  share.useCount ?? (share.guestName !== null ? 1 : guestShareGuests(share).length);

const pendingAttachments = (share: ThreadGuestShare | null) =>
  share?.messages.flatMap((message) =>
    message.status === "pending" ? (message.attachments ?? []) : [],
  ) ?? [];

/**
 * Stored files a share change leaves behind: those of waiting messages that were dismissed or
 * dropped with the share. A sent message keeps its files, which its thread message now holds.
 */
export function releasedGuestAttachmentIds(
  before: ThreadGuestShare | null,
  after: ThreadGuestShare | null,
): ReadonlyArray<string> {
  const kept = new Set(
    after !== null && after.id === before?.id
      ? after.messages.flatMap((message) =>
          message.status === "dismissed"
            ? []
            : (message.attachments ?? []).map((attachment) => attachment.id),
        )
      : [],
  );
  return pendingAttachments(before)
    .map((attachment) => attachment.id)
    .filter((id) => !kept.has(id));
}

/** Keeps every pending message and only the newest resolved ones. */
function trimResolved(messages: ReadonlyArray<ThreadGuestMessage>): Array<ThreadGuestMessage> {
  let resolvedBudget = GUEST_RESOLVED_MESSAGE_LIMIT;
  const kept: Array<ThreadGuestMessage> = [];
  for (const message of messages.toReversed()) {
    if (message.status !== "pending") {
      if (resolvedBudget === 0) continue;
      resolvedBudget -= 1;
    }
    kept.push(message);
  }
  return kept.toReversed();
}

const resolveMessage = (
  share: ThreadGuestShare,
  guestMessageId: GuestMessageId,
  status: "sent" | "dismissed",
): Result.Result<ThreadGuestShare, string> => {
  const message = share.messages.find((candidate) => candidate.id === guestMessageId);
  if (message === undefined || message.status !== "pending") {
    return Result.fail(`Guest message ${guestMessageId} is not pending.`);
  }
  return Result.succeed({
    ...share,
    messages: trimResolved(
      share.messages.map((candidate) =>
        candidate.id === guestMessageId ? { ...candidate, status } : candidate,
      ),
    ),
  });
};

/**
 * Applies a guest share command to the thread. The orchestrator runs commands one at a time, so
 * checking state here enforces lifetime redemption capacity and sends each message once.
 */
export function decideGuestShareCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: GuestShareCommand;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command, now } = input;
  const share = thread.guestShare ?? null;
  const withShare = (guestShare: ThreadGuestShare | null) =>
    Result.succeed({ ...thread, guestShare, updatedAt: now });

  switch (command.type) {
    case "thread.guest-share.open": {
      if (thread.archivedAt !== null) return Result.fail("Archived mines cannot be shared.");
      return withShare({
        id: command.shareId,
        host: command.host,
        createdAt: DateTime.formatIso(now),
        expiresAt: command.expiresAt,
        guestName: null,
        messages: [],
        ...(command.permission === undefined ? {} : { permission: command.permission }),
        ...(command.maxGuests === undefined ? {} : { maxGuests: command.maxGuests }),
        ...(command.permission === undefined && command.maxGuests === undefined
          ? {}
          : { guests: [], useCount: 0 }),
      });
    }
    case "thread.guest-share.close":
      return share === null ? Result.succeed(thread) : withShare(null);
    case "thread.guest-share.unban": {
      const guestBannedIps = (thread.guestBannedIps ?? []).filter((ip) => ip !== command.ipAddress);
      return guestBannedIps.length === (thread.guestBannedIps?.length ?? 0)
        ? Result.succeed(thread)
        : Result.succeed({ ...thread, guestBannedIps, updatedAt: now });
    }
    case "thread.guest-share.kick":
    case "thread.guest-share.ban": {
      if (share === null) return Result.fail("This mine has no guest link.");
      const guests = guestShareGuests(share);
      const guest = guests.find((candidate) => candidate.id === command.guestId);
      if (guest === undefined) return Result.succeed(thread);
      if (command.type === "thread.guest-share.kick") {
        return withShare({
          ...share,
          useCount: guestShareUseCount(share),
          guests: guests.filter((candidate) => candidate.id !== guest.id),
        });
      }
      if (guest.ipAddress === undefined) return Result.fail("This guest has no IP address to ban.");
      const banned = thread.guestBannedIps ?? [];
      if (!banned.includes(guest.ipAddress) && banned.length >= GUEST_BANNED_IP_LIMIT) {
        return Result.fail("This mine has reached its guest IP ban limit.");
      }
      return Result.succeed({
        ...thread,
        guestBannedIps: banned.includes(guest.ipAddress) ? banned : [...banned, guest.ipAddress],
        guestShare: {
          ...share,
          useCount: guestShareUseCount(share),
          guests: guests.filter((candidate) => candidate.ipAddress !== guest.ipAddress),
        },
        updatedAt: now,
      });
    }
    case "thread.guest-share.redeem": {
      if (share === null || share.id !== command.shareId || isExpired(share, now)) {
        return Result.fail(GUEST_FAILURE.inactive);
      }
      const guests = guestShareGuests(share);
      const useCount = guestShareUseCount(share);
      if (useCount >= (share.maxGuests ?? 1)) return Result.fail(GUEST_FAILURE.used);
      if (command.guestId === undefined) {
        return share.guests !== undefined || command.ipAddress !== undefined
          ? Result.fail(GUEST_FAILURE.inactive)
          : withShare({ ...share, guestName: command.guestName, useCount: useCount + 1 });
      }
      if (command.ipAddress === undefined || guests.some((guest) => guest.id === command.guestId)) {
        return Result.fail(GUEST_FAILURE.inactive);
      }
      if (thread.guestBannedIps?.includes(command.ipAddress))
        return Result.fail(GUEST_FAILURE.banned);
      return withShare({
        ...share,
        guestName: share.guestName ?? command.guestName,
        useCount: useCount + 1,
        guests: [
          ...guests,
          {
            id: command.guestId,
            name: command.guestName,
            joinedAt: DateTime.formatIso(now),
            ipAddress: command.ipAddress,
          },
        ],
      });
    }
    case "thread.guest-share.update-ip": {
      if (share === null || share.id !== command.shareId || isExpired(share, now)) {
        return Result.fail(GUEST_FAILURE.inactive);
      }
      const guests = guestShareGuests(share);
      const guest = guests.find((candidate) => candidate.id === command.guestId);
      if (guest === undefined) return Result.fail(GUEST_FAILURE.inactive);
      if (thread.guestBannedIps?.includes(command.ipAddress)) {
        return Result.fail(GUEST_FAILURE.banned);
      }
      return guest.ipAddress === command.ipAddress
        ? Result.succeed(thread)
        : withShare({
            ...share,
            guests: guests.map((candidate) =>
              candidate.id === guest.id
                ? { ...candidate, ipAddress: command.ipAddress }
                : candidate,
            ),
          });
    }
    case "thread.guest-message.submit": {
      if (
        share === null ||
        share.id !== command.shareId ||
        share.guestName === null ||
        isExpired(share, now)
      ) {
        return Result.fail(GUEST_FAILURE.inactive);
      }
      const guest = guestShareGuests(share).find((candidate) => candidate.id === command.guestId);
      if (
        (command.guestId !== undefined && guest === undefined) ||
        (command.guestId === undefined && share.guests !== undefined) ||
        (guest?.ipAddress !== undefined && thread.guestBannedIps?.includes(guest.ipAddress))
      )
        return Result.fail(GUEST_FAILURE.inactive);
      const permission = guestSharePermission(share);
      if (permission === "viewer") return Result.fail(GUEST_FAILURE.viewer);
      const attachments = command.attachments ?? [];
      const existing = share.messages.find((message) => message.id === command.guestMessageId);
      if (existing !== undefined) {
        return existing.text === command.text &&
          existing.guestId === command.guestId &&
          attachmentsEqual(existing.attachments ?? [], attachments)
          ? Result.succeed(thread)
          : Result.fail("This guest message retry does not match the original message.");
      }
      if (
        share.messages.filter((message) => message.status === "pending").length >=
        GUEST_PENDING_MESSAGE_LIMIT
      ) {
        return Result.fail(GUEST_FAILURE.busy);
      }
      const pendingBytes = [...pendingAttachments(share), ...attachments].reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0,
      );
      if (attachments.length > 0 && pendingBytes > GUEST_PENDING_ATTACHMENT_BYTES_LIMIT) {
        return Result.fail(GUEST_FAILURE.filesBusy);
      }
      const guestShare: ThreadGuestShare = {
        ...share,
        messages: trimResolved([
          ...share.messages,
          {
            id: command.guestMessageId,
            text: command.text,
            status: "pending",
            submittedAt: DateTime.formatIso(now),
            ...(guest === undefined ? {} : { guestId: guest.id, guestName: guest.name }),
            ...(permission === "send" ? { direct: true } : {}),
            ...(attachments.length === 0 ? {} : { attachments }),
          },
        ]),
      };
      // A request needs the owner, so a settled thread comes back as a new message brings it.
      return thread.settledOverride === "settled"
        ? Result.succeed({
            ...thread,
            guestShare,
            settledOverride: null,
            settledAt: null,
            unsettledAt: now,
            updatedAt: now,
          })
        : withShare(guestShare);
    }
    case "thread.guest-message.dismiss": {
      if (share === null) return Result.fail("This mine has no guest link.");
      return Result.map(resolveMessage(share, command.guestMessageId, "dismissed"), (next) => ({
        ...thread,
        guestShare: next,
        updatedAt: now,
      }));
    }
  }
}

/**
 * Marks a guest message sent. `text` is what the agent receives: it names the guest so the agent
 * does not mistake it for the owner's words, and so a guest cannot start a slash command.
 * `guest` lets clients show the guest's own text with their name beside it.
 */
export function decideGuestMessageSend(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly guestMessageId: GuestMessageId;
  readonly now: DateTime.Utc;
}): Result.Result<
  {
    readonly thread: OrchestrationV2AppThread;
    readonly text: string;
    readonly guest: GuestMessageAttribution;
  },
  string
> {
  const share = input.thread.guestShare ?? null;
  if (share === null) return Result.fail("This mine has no guest link.");
  const message = share.messages.find((candidate) => candidate.id === input.guestMessageId);
  if (message?.direct === true) {
    const author = guestShareGuests(share).find((guest) => guest.id === message.guestId);
    if (
      author === undefined ||
      guestSharePermission(share) !== "send" ||
      isExpired(share, input.now) ||
      (author.ipAddress !== undefined && input.thread.guestBannedIps?.includes(author.ipAddress))
    )
      return Result.fail(GUEST_FAILURE.inactive);
  }
  const name = message?.guestName ?? share.guestName ?? "Guest";
  const guestText = message?.text ?? "";
  return Result.map(resolveMessage(share, input.guestMessageId, "sent"), (next) => ({
    thread: { ...input.thread, guestShare: next, updatedAt: input.now },
    text: `Message from guest ${name}${message?.direct === true ? "" : ", sent by the owner"}:\n\n${guestText}`,
    guest: {
      guestMessageId: input.guestMessageId,
      name,
      text: guestText,
      shareId: share.id,
      ...(message?.guestId === undefined ? {} : { guestId: message.guestId }),
      ...(message?.direct === true ? { direct: true } : {}),
    },
  }));
}

/**
 * The owner cancelled a queued send, so the agent never got the message. It shows as dismissed,
 * which the guest can see, instead of sent with no reply ever coming. A share that changed since
 * the send is left alone.
 */
export function guestShareAfterCancelledSend(
  thread: OrchestrationV2AppThread,
  guest: Pick<GuestMessageAttribution, "guestMessageId" | "shareId">,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  const share = thread.guestShare ?? null;
  if (share === null || share.id !== guest.shareId) return thread;
  const message = share.messages.find((candidate) => candidate.id === guest.guestMessageId);
  if (message?.status !== "sent") return thread;
  return {
    ...thread,
    guestShare: {
      ...share,
      messages: share.messages.map((candidate) =>
        candidate.id === guest.guestMessageId ? { ...candidate, status: "dismissed" } : candidate,
      ),
    },
    updatedAt: now,
  };
}

/** Guest attribution comes only from `decideGuestMessageSend`; a client cannot claim it. */
export function withoutGuestAttribution<
  C extends { readonly context?: OrchestrationMessageContext | undefined },
>(command: C): C {
  if (command.context?.guest === undefined) return command;
  const { guest: _guest, ...context } = command.context;
  return { ...command, context };
}
