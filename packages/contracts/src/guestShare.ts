import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";
import {
  GuestMessageId,
  GuestShareId,
  GuestSessionId,
  MessageId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const DEFAULT_GUEST_SHARE_TTL_MS = 6 * 60 * 60 * 1000;
export const GUEST_SHARE_MAX_GUESTS = 100;
export const GUEST_BANNED_IP_LIMIT = 1_000;
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_PENDING_MESSAGE_LIMIT = 3;
/** Resolved messages kept so the guest can see what happened to what they sent. */
export const GUEST_RESOLVED_MESSAGE_LIMIT = 20;
/** Files a guest can attach to one message, and their total size. */
export const GUEST_MESSAGE_MAX_ATTACHMENTS = 4;
export const GUEST_MESSAGE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Total size of the files in a share's waiting messages, so a guest cannot fill the disk. */
export const GUEST_PENDING_ATTACHMENT_BYTES_LIMIT = 20 * 1024 * 1024;

export const ThreadGuestMessageStatus = Schema.Literals(["pending", "sent", "dismissed"]);
export type ThreadGuestMessageStatus = typeof ThreadGuestMessageStatus.Type;

export const GuestSharePermission = Schema.Literals(["viewer", "confirm", "send"]);
export type GuestSharePermission = typeof GuestSharePermission.Type;

export const GuestShareMaxGuests = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: GUEST_SHARE_MAX_GUESTS }),
);

export const ThreadGuestSession = Schema.Struct({
  id: GuestSessionId,
  name: TrimmedNonEmptyString,
  joinedAt: IsoDateTime,
  ipAddress: Schema.optional(TrimmedNonEmptyString),
  permission: Schema.optional(Schema.Literals(["viewer", "confirm"])),
});
export type ThreadGuestSession = typeof ThreadGuestSession.Type;

export const ThreadGuestMessage = Schema.Struct({
  id: GuestMessageId,
  text: Schema.String,
  status: ThreadGuestMessageStatus,
  submittedAt: IsoDateTime,
  guestId: Schema.optional(GuestSessionId),
  guestName: Schema.optional(TrimmedNonEmptyString),
  direct: Schema.optional(Schema.Boolean),
  revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  editedAt: Schema.optional(IsoDateTime),
  deletedAt: Schema.optional(IsoDateTime),
  sentMessageId: Schema.optional(MessageId),
  /** The thread's attachments, deleted if the message is dismissed. Absent on older messages. */
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ThreadGuestMessage = typeof ThreadGuestMessage.Type;

export const ThreadGuestShare = Schema.Struct({
  id: GuestShareId,
  /** The active public endpoint identity, or a legacy tunnel hostname. */
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** The first guest's name, retained for older clients. */
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  permission: Schema.optional(GuestSharePermission),
  maxGuests: Schema.optional(GuestShareMaxGuests),
  useCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: GUEST_SHARE_MAX_GUESTS })),
  ),
  guests: Schema.optional(
    Schema.Array(ThreadGuestSession).check(Schema.isMaxLength(GUEST_SHARE_MAX_GUESTS)),
  ),
  messages: Schema.Array(ThreadGuestMessage),
});
export type ThreadGuestShare = typeof ThreadGuestShare.Type;

export const guestSharePermission = (
  share: ThreadGuestShare | null | undefined,
): GuestSharePermission => share?.permission ?? "confirm";

export const guestShareGuests = (
  share: ThreadGuestShare | null | undefined,
): ReadonlyArray<ThreadGuestSession> => share?.guests ?? [];

export const guestSessionPermission = (
  share: ThreadGuestShare | null | undefined,
  guestId: GuestSessionId | undefined,
): GuestSharePermission =>
  guestShareGuests(share).find((guest) => guest.id === guestId)?.permission ??
  guestSharePermission(share);

export const pendingGuestMessageCount = (share: ThreadGuestShare | null | undefined): number =>
  share?.messages.filter((message) => message.status === "pending" && !message.deletedAt).length ??
  0;

export const GuestShareCreateInput = Schema.Struct({
  threadId: ThreadId,
  permission: Schema.optional(GuestSharePermission),
  maxGuests: Schema.optional(GuestShareMaxGuests),
  durationHours: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 168 })),
  ),
});
export type GuestShareCreateInput = typeof GuestShareCreateInput.Type;

export const GuestShareCreateResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  share: ThreadGuestShare,
});
export type GuestShareCreateResult = typeof GuestShareCreateResult.Type;

const GUEST_SHARE_CREATE_MESSAGES = {
  disabled: "Guest links are off. Turn them on in Settings > Beta.",
  connect_unavailable: "Public guest sharing is not available. Check this device’s connection.",
  thread_unavailable: "This mine cannot be shared.",
  read_failed: "Failed to read the shared mine.",
  changed: "The guest link changed while it was being created.",
  invalid_options: "Choose a valid guest permission, guest limit, and link duration.",
} as const;

export class GuestShareCreateError extends Schema.TaggedError<GuestShareCreateError>()(
  "GuestShareCreateError",
  {
    reason: Schema.Literals([
      "disabled",
      "connect_unavailable",
      "thread_unavailable",
      "read_failed",
      "changed",
      "invalid_options",
    ]),
  },
) {
  override get message(): string {
    return GUEST_SHARE_CREATE_MESSAGES[this.reason];
  }
}

// The name lands in the agent's attribution line, so it must stay one plain line, and the owner
// reads it, so direction overrides cannot make it look like another name.
const NAME_BREAKING_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export const GuestRedeemRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(
    Schema.isMaxLength(GUEST_NAME_MAX_LENGTH),
    Schema.makeFilter((name) => !NAME_BREAKING_CHARACTER.test(name), {
      description: "a single line of text",
    }),
  ),
});
export type GuestRedeemRequest = typeof GuestRedeemRequest.Type;

/**
 * The fields of a guest message. The page posts them as multipart form data, with each file as a
 * `file` part; text can be empty when files are attached.
 */
export const GuestSubmitRequest = Schema.Struct({
  /** The share the page shows, so a message from a page for a replaced link is refused instead
      of reaching the new one. */
  shareId: GuestShareId,
  text: TrimmedString.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type GuestSubmitRequest = typeof GuestSubmitRequest.Type;

export const GuestDeleteRequest = Schema.Struct({
  shareId: GuestShareId,
  guestMessageId: GuestMessageId,
  messageId: Schema.optional(MessageId),
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type GuestDeleteRequest = typeof GuestDeleteRequest.Type;

export const GuestEditRequest = Schema.Struct({
  ...GuestDeleteRequest.fields,
  text: TrimmedString.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GuestEditRequest = typeof GuestEditRequest.Type;

export const GUEST_ROUTE_PREFIX = "/api/guest";
/** The guest page and guest routes name the share they mean with this query parameter. */
export const GUEST_SHARE_PARAM = "share";

/**
 * One session cookie per share, so a guest keeps every link they joined on a host, and a page
 * for one share never acts with another share's session.
 */
export const guestSessionCookieName = (shareId: string) => `mines_guest_${shareId}`;
/** Serves one HTML render in the shared thread: `?share=<share id>&item=<turn item id>`. */
export const GUEST_RENDER_ROUTE = `${GUEST_ROUTE_PREFIX}/render`;
/** One item of the shared thread, as an expanded row loads it: `?share=<share id>&item=<id>`. */
export const GUEST_ITEM_ROUTE = `${GUEST_ROUTE_PREFIX}/item`;
/** Server-sent output frames of one command in the shared thread: `?share=<share id>&item=<id>`. */
export const GUEST_COMMAND_OUTPUT_ROUTE = `${GUEST_ROUTE_PREFIX}/command-output`;
/**
 * A file in the shared thread or a guest's waiting message: `?share=<share id>&id=<attachment id>`.
 * Images load inline; other files download.
 */
export const GUEST_ATTACHMENT_ROUTE = `${GUEST_ROUTE_PREFIX}/attachment`;
