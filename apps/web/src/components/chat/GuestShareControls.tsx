import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  guestShareGuests,
  guestSharePermission,
  type ChatAttachment,
  type GuestMessageId,
  type GuestSessionId,
  type GuestShareId,
  type GuestSharePermission,
  type ScopedThreadRef,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, HammerIcon, LinkIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { environmentPresentations } from "~/state/presentation";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useAssetUrls } from "~/assets/assetUrls";
import { type ChatFileAttachment, isImageAttachment } from "../../types";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { GuestMessageAttachments } from "./GuestMessageAttachments";
import { GuestMessageName, guestBubbleClassName } from "./guestMessageStyle";
import { guestMessageAuthorName } from "./guestMessageAuthor";
import { guestShareDialogThreadAtom, openGuestShareDialog } from "./guestShareDialogState";
import { guestShareLinkAvailable } from "./guestShareLinkAvailability";

const GUEST_PERMISSION_LABELS = {
  viewer: "Viewer",
  confirm: "Write · owner confirms",
  send: "Write & send directly",
} satisfies Record<GuestSharePermission, string>;

function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  return useQuietThreadProjection(threadRef)?.projection.thread.guestShare ?? null;
}

export function GuestShareDialogHost() {
  const threadRef = useAtomValue(guestShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <GuestShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(guestShareDialogThreadAtom, null)}
    />
  );
}

type CreateState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "created"; readonly url: string; readonly shareId: GuestShareId }
  | { readonly status: "failed"; readonly message: string };

function GuestShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const activeShare = useThreadGuestShare(threadRef);
  const sharingEnabled =
    useAtomValue(environmentPresentations.serverConfigsAtom).get(threadRef.environmentId)?.settings
      .guestSharingEnabled === true;
  const canCreate = useAtomValue(
    serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId),
  );
  const createGuestShare = useAtomCommand(serverEnvironment.createGuestShare, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "guest link" });
  const [state, setState] = useState<CreateState>({ status: "idle" });
  const [maxGuests, setMaxGuests] = useState("1");
  const [durationHours, setDurationHours] = useState("6");
  const [permission, setPermission] = useState<GuestSharePermission>("viewer");
  const formId = useId();
  const peopleId = useId();
  const durationId = useId();
  const permissionId = useId();
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = activeShare?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);
  const createdUrl =
    state.status === "created" &&
    state.shareId === activeShare?.id &&
    guestShareLinkAvailable(activeShare, now)
      ? state.url
      : null;

  const create = async () => {
    if (!canCreate || !sharingEnabled || state.status === "creating") return;
    setState({ status: "creating" });
    const result = await createGuestShare({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        maxGuests: Number(maxGuests),
        durationHours: Number(durationHours),
        permission,
      },
    });
    if (result._tag === "Success") {
      setState({ status: "created", url: result.value.url, shareId: result.value.share.id });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a guest link.",
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "creating") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share link</DialogTitle>
          <DialogDescription>
            Guests choose a nickname and can see this conversation, including command output and the
            agent&apos;s reasoning.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!sharingEnabled ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">
                Enable Guest links for this environment.
              </p>
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/settings/beta"
                    search={{ machine: threadRef.environmentId }}
                    hash="guest-links"
                    onClick={onClose}
                  />
                }
              >
                Open Guest links settings
              </Button>
            </div>
          ) : createdUrl !== null ? (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Guest link"
                value={createdUrl}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(createdUrl)}>
                {isCopied ? <CheckIcon /> : <CopyIcon />}
                {isCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <fieldset disabled={!canCreate || state.status === "creating"} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor={peopleId}>People limit</Label>
                    <Input
                      id={peopleId}
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      required
                      value={maxGuests}
                      onChange={(event) => setMaxGuests(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={durationId}>Duration (hours)</Label>
                    <Input
                      id={durationId}
                      type="number"
                      min={0.25}
                      max={168}
                      step="any"
                      required
                      value={durationHours}
                      onChange={(event) => setDurationHours(event.currentTarget.value)}
                    />
                    <p className="text-muted-foreground text-xs">15 min to 7 days</p>
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">
                  Up to {maxGuests || "1"} {maxGuests === "1" ? "person can" : "people can"} join
                  with this link. Kicking a guest does not free a use.
                </p>
                <div className="space-y-2">
                  <Label htmlFor={permissionId}>Permission</Label>
                  <Select
                    value={permission}
                    items={GUEST_PERMISSION_LABELS}
                    onValueChange={(value) => {
                      if (value) setPermission(value);
                    }}
                  >
                    <SelectTrigger id={permissionId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {Object.entries(GUEST_PERMISSION_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    {permission === "viewer"
                      ? "Guests can read the conversation."
                      : permission === "confirm"
                        ? "You send or dismiss each guest message."
                        : "Guest messages go straight to the agent."}
                  </p>
                </div>
                {activeShare !== null ? (
                  <p className="text-muted-foreground text-xs">
                    Creating a new link disconnects current guests and replaces the previous link.
                  </p>
                ) : null}
              </fieldset>
            </form>
          )}
          <GuestShareManagement
            threadRef={threadRef}
            onRevoke={() => setState({ status: "idle" })}
            now={now}
          />
          {state.status === "failed" ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {!sharingEnabled || createdUrl !== null ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={state.status === "creating"}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                form={formId}
                disabled={!canCreate || !sharingEnabled || state.status === "creating"}
              >
                {state.status === "creating" ? "Creating..." : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function GuestShareManagement({
  threadRef,
  onRevoke,
  now,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onRevoke: () => void;
  readonly now: number;
}) {
  const thread = useQuietThreadProjection(threadRef)?.projection.thread;
  const share = thread?.guestShare ?? null;
  const bannedIps = thread?.guestBannedIps ?? [];
  const canRevoke = useAtomValue(
    threadEnvironment.closeGuestShare.permissionAtom(threadRef.environmentId),
  );
  const canUnban = useAtomValue(
    threadEnvironment.unbanGuest.permissionAtom(threadRef.environmentId),
  );
  const closeGuestShare = useAtomCommand(threadEnvironment.closeGuestShare, {
    label: "revoke guest link",
  });
  const unbanGuest = useAtomCommand(threadEnvironment.unbanGuest, { label: "unban guest IP" });
  const [busy, setBusy] = useState<string | null>(null);
  if (share === null && bannedIps.length === 0) return null;
  const expired = share !== null && Date.parse(share.expiresAt) <= now;
  const maxGuests = share?.maxGuests ?? 1;
  const useCount = share?.useCount ?? share?.guests?.length ?? (share?.guestName ? 1 : 0);

  return (
    <div className="space-y-4 border-t border-border pt-4">
      {share !== null ? (
        <section className="space-y-3" aria-label="Current share link">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{expired ? "Expired link" : "Current link"}</h3>
              <p className="text-muted-foreground text-xs">
                {guestSharePermission(share) === "viewer"
                  ? "Viewer"
                  : guestSharePermission(share) === "confirm"
                    ? "Write · owner confirms"
                    : "Write & send directly"}
                {" · "}
                {useCount}/{maxGuests} {maxGuests === 1 ? "use" : "uses"}
              </p>
              <p className="text-muted-foreground text-xs">
                {expired ? "Expired " : "Expires "}
                <time dateTime={share.expiresAt}>{new Date(share.expiresAt).toLocaleString()}</time>
              </p>
            </div>
            <Button
              size="xs"
              variant="plain-destructive"
              disabled={!canRevoke || busy !== null}
              onClick={async () => {
                if (!canRevoke || busy !== null) return;
                setBusy("revoke");
                const result = await closeGuestShare({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                });
                setBusy(null);
                if (result._tag === "Success") onRevoke();
              }}
            >
              {busy === "revoke" ? "Revoking…" : "Revoke link"}
            </Button>
          </div>
          <GuestParticipantList threadRef={threadRef} share={share} />
        </section>
      ) : null}
      {bannedIps.length > 0 ? (
        <section className="space-y-2" aria-label="Banned guest IPs">
          <h3 className="text-sm font-medium">Banned IPs</h3>
          <p className="text-muted-foreground text-xs">
            These addresses cannot join this conversation, including through a new link.
          </p>
          <ul className="space-y-1">
            {bannedIps.map((ipAddress) => (
              <li key={ipAddress} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-xs">{ipAddress}</span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canUnban || busy !== null}
                  onClick={async () => {
                    if (!canUnban || busy !== null) return;
                    setBusy(ipAddress);
                    await unbanGuest({
                      environmentId: threadRef.environmentId,
                      input: { threadId: threadRef.threadId, ipAddress },
                    });
                    setBusy(null);
                  }}
                >
                  {busy === ipAddress ? "Unbanning…" : "Unban"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function GuestParticipantList({
  threadRef,
  share,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly share: ThreadGuestShare;
}) {
  const guests = guestShareGuests(share);
  const canKick = useAtomValue(threadEnvironment.kickGuest.permissionAtom(threadRef.environmentId));
  const canBan = useAtomValue(threadEnvironment.banGuest.permissionAtom(threadRef.environmentId));
  const kickGuest = useAtomCommand(threadEnvironment.kickGuest, { label: "kick guest" });
  const banGuest = useAtomCommand(threadEnvironment.banGuest, { label: "ban guest IP" });
  const [busyId, setBusyId] = useState<GuestSessionId | null>(null);
  const moderate = async (guestId: GuestSessionId, action: "kick" | "ban") => {
    if (busyId !== null || !(action === "kick" ? canKick : canBan)) return;
    setBusyId(guestId);
    const command = action === "kick" ? kickGuest : banGuest;
    await command({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, guestId },
    });
    setBusyId(null);
  };

  if (guests.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {share.guests === undefined && share.guestName
          ? `${share.guestName} joined as a guest.`
          : "No guests are currently joined."}
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Guest participants">
      {guests.map((guest) => (
        <li key={guest.id} className="flex items-center gap-2">
          <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span dir="auto" className="min-w-0 flex-1 truncate text-sm">
            {guest.name}
          </span>
          <span className="text-muted-foreground text-xs">Guest</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="plain-destructive"
                  aria-label={`Kick ${guest.name}`}
                  disabled={!canKick || busyId !== null}
                  onClick={() => void moderate(guest.id, "kick")}
                />
              }
            >
              <XIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Kick {guest.name}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="plain-destructive"
                  aria-label={`Ban ${guest.name}'s IP from this conversation`}
                  disabled={!canBan || busyId !== null || !guest.ipAddress}
                  onClick={() => void moderate(guest.id, "ban")}
                />
              }
            >
              <HammerIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              {guest.ipAddress
                ? "Ban this IP from this conversation. Guests sharing the address will be disconnected."
                : "IP address unavailable for this guest."}
            </TooltipPopup>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

export function GuestShareParticipants({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadGuestShare(threadRef);
  const names = share ? guestShareGuests(share).map((guest) => guest.name) : [];
  if (share?.guests === undefined && share?.guestName) names.push(share.guestName);
  if (share === null || names.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost-muted" aria-label="Guest participants" />}
      >
        <UsersIcon aria-hidden />
        <span className="max-w-48 truncate">{names.join(", ")}</span>
        <span>{names.length === 1 ? "guest" : `${names.length} guests`}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" align="start">
        <div className="space-y-3">
          <PopoverTitle>Guest participants</PopoverTitle>
          <GuestParticipantList threadRef={threadRef} share={share} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function GuestShareButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const canCreate = useAtomValue(
    serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId),
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canCreate}
      onClick={() => openGuestShareDialog(threadRef)}
    >
      <LinkIcon aria-hidden />
      Share link
    </Button>
  );
}

/**
 * A guest's messages wait at the end of the timeline until the owner sends or dismisses each one.
 * Sent ones then show in the timeline as normal user messages with the guest's name.
 */
export function GuestPendingMessages({
  threadRef,
  onImageExpand,
  onFileOpen,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}) {
  const share = useThreadGuestShare(threadRef);
  const canOperate = useAtomValue(
    threadEnvironment.resolveGuestMessage.permissionAtom(threadRef.environmentId),
  );
  const resolveGuestMessage = useAtomCommand(threadEnvironment.resolveGuestMessage, {
    label: "resolve guest message",
  });
  const [busyIds, setBusyIds] = useState<ReadonlySet<GuestMessageId>>(new Set());
  const pending = share?.messages.filter((message) => message.status === "pending") ?? [];
  // The files are the thread's attachments, which the owner's environment serves like any other.
  const images = pending.flatMap((message) => message.attachments ?? []).filter(isImageAttachment);
  const imageUrls = useAssetUrls(
    threadRef.environmentId,
    images.map((image) => ({ _tag: "attachment" as const, attachmentId: image.id })),
  );
  const imageUrlById = new Map(
    images.flatMap((image, index) => {
      const url = imageUrls[index];
      return url ? [[image.id, url] as const] : [];
    }),
  );
  if (share === null || pending.length === 0) return null;
  const openImage = (attachment: ChatAttachment) => {
    const preview = buildExpandedImagePreview(
      images.map((image) => ({ ...image, previewUrl: imageUrlById.get(image.id) ?? "" })),
      attachment.id,
    );
    if (preview) onImageExpand(preview);
  };

  const resolve = async (guestMessageId: GuestMessageId, decision: "send" | "dismiss") => {
    setBusyIds((ids) => new Set(ids).add(guestMessageId));
    await resolveGuestMessage({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, guestMessageId, decision },
    });
    setBusyIds((ids) => {
      const next = new Set(ids);
      next.delete(guestMessageId);
      return next;
    });
  };

  return (
    <ol
      className="chat-content-lane flex flex-col gap-4 pb-4"
      aria-label={`${pending.length} guest message${pending.length === 1 ? "" : "s"} waiting`}
      aria-live="polite"
    >
      {pending.map((message) => {
        const busy = busyIds.has(message.id);
        const guestName = guestMessageAuthorName(message, share);
        return (
          <li key={message.id} className="flex flex-col items-end gap-1">
            <GuestMessageName name={guestName} />
            <div
              className={cn(
                "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3 text-foreground",
                guestBubbleClassName(true),
              )}
            >
              <GuestMessageAttachments
                attachments={message.attachments ?? []}
                imageUrl={(attachment) => imageUrlById.get(attachment.id)}
                onOpenImage={openImage}
                onOpenFile={onFileOpen}
              />
              {message.text ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.text}
                </p>
              ) : null}
            </div>
            {canOperate ? (
              <div className="flex items-center gap-1 pe-1">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy}
                  aria-label={`Dismiss message from ${guestName}`}
                  onClick={() => void resolve(message.id, "dismiss")}
                >
                  Dismiss
                </Button>
                <Button
                  size="xs"
                  disabled={busy}
                  aria-label={`Send message from ${guestName}`}
                  onClick={() => void resolve(message.id, "send")}
                >
                  Send
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
