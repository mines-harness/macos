import {
  EnvironmentId,
  GUEST_MESSAGE_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GuestMessageId,
  type GuestDeleteRequest,
  type GuestEditRequest,
  type GuestRedeemRequest,
  type GuestActivityRequest,
  type GuestShareView,
  type GuestThreadModel,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type ThreadGuestMessage,
  type ThreadGuestMessageStatus,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import { ArrowUpIcon, CheckIcon, PaperclipIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  createRef,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import {
  useActiveConversationActivity,
  useConversationActivityPublisher,
} from "~/hooks/useConversationActivity";
import { cn, randomUUID } from "~/lib/utils";
import { guestApiUrl } from "~/guestRouting";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { ConversationActivityBubble } from "../chat/ConversationActivity";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { GuestMessageAttachments } from "../chat/GuestMessageAttachments";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { GuestMessageName, guestBubbleClassName } from "../chat/guestMessageStyle";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import type { TimelineRow } from "../chat/timelineRowContext";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import { GuestHtmlRender } from "./GuestHtmlRender";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  applyGuestStreamEvent,
  formatGuestExpiry,
  guestAttachmentUrl,
  createGuestAttachmentUrls,
  guestFilesProblem,
  initialGuestStreamState,
  inviteShareId,
  latestEditableGuestMessage,
  type GuestStreamState,
  unplacedGuestMessages,
} from "./guestStream.logic";
import { guestTurnItemSource } from "./guestTurnItemSource";
import { connectGuestStream } from "./guestConnection";

interface GuestEntry {
  /** Unspent invite from the URL hash, if this load came from a link. */
  readonly credential: string | null;
  readonly shareId: string | null;
}

let capturedEntry: GuestEntry | null = null;

// A reload keeps the tab's session, so it keeps which messages still wait for a row too.
const AWAITING_ROWS_KEY = "mines:guest-awaiting-rows";
const AWAITING_ROWS_LIMIT = 50;

function readAwaitingRowIds(): ReadonlySet<GuestMessageId> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(AWAITING_ROWS_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id) => typeof id === "string").map((id) => GuestMessageId.make(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeAwaitingRowIds(ids: ReadonlySet<GuestMessageId>) {
  try {
    sessionStorage.setItem(AWAITING_ROWS_KEY, JSON.stringify([...ids].slice(-AWAITING_ROWS_LIMIT)));
  } catch {}
}

/**
 * The invite credential travels in the URL hash so it never reaches a server log. It is read
 * once and removed from history, so it lives only in memory. Opening the page never redeems it:
 * only submitting a name does, so a reload before that leaves the link usable.
 */
function takeGuestEntry(): GuestEntry {
  if (capturedEntry === null) {
    // A malformed fragment is an invalid link, not a crash.
    let credential = "";
    try {
      credential = decodeURIComponent(window.location.hash.slice(1)).trim();
    } catch {}
    const shareId =
      credential !== ""
        ? inviteShareId(credential)
        : new URLSearchParams(window.location.search).get(GUEST_SHARE_PARAM);
    const search = new URLSearchParams();
    const host = new URLSearchParams(window.location.search).get("host");
    if (host !== null) search.set("host", host);
    if (shareId !== null) search.set(GUEST_SHARE_PARAM, shareId);
    // The share stays in the URL, so a reload or bookmark finds this browser's session for it.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search.size === 0 ? "" : `?${search}`}`,
    );
    capturedEntry = { credential: credential === "" ? null : credential, shareId };
  }
  return capturedEntry;
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

/** Resolves to null on success, or to a message the guest can read. */
async function postGuest(
  path: "redeem" | `messages?${string}` | `activity?${string}`,
  body:
    | typeof GuestRedeemRequest.Encoded
    | FormData
    | GuestEditRequest
    | GuestDeleteRequest
    | GuestActivityRequest,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<string | null> {
  try {
    const response = await fetch(
      guestApiUrl(`${GUEST_ROUTE_PREFIX}/${path}`),
      body instanceof FormData
        ? { method: "POST", body }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            ...(path.startsWith("activity?") ? { keepalive: true } : {}),
          },
    );
    if (response.ok) return null;
    const json: unknown = await response.json().catch(() => null);
    return Option.match(decodeErrorBody(json), {
      onNone: () => "Something went wrong. Try again.",
      onSome: ({ message }) => message,
    });
  } catch {
    return "Could not reach the server.";
  }
}

const STATUS_LABEL: Record<ThreadGuestMessageStatus, string> = {
  pending: "Waiting for approval",
  sent: "Sent",
  dismissed: "Not sent",
};

/** Same column as the owner's timeline, so both views wrap text at the same width. */
const LANE = "chat-content-lane px-4";

type GuestAccess = "checking" | "session" | "name" | "none";

export function GuestPage() {
  const [{ credential, shareId }] = useState(takeGuestEntry);
  // A browser that already joined this share goes straight back in, even from the spent link.
  // Sessions are per share, so one for another link never stands in for this one.
  const [access, setAccess] = useState<GuestAccess>(shareId === null ? "none" : "checking");
  useEffect(() => {
    if (shareId === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch(
          guestApiUrl(
            `${GUEST_ROUTE_PREFIX}/session?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
          ),
          { signal: controller.signal },
        );
        if (!live) return;
        if (response.ok || response.status === 403) {
          setAccess(response.ok ? "session" : credential !== null ? "name" : "none");
          return;
        }
      } catch {}
      if (live) timer = setTimeout(() => void check(), 2_000);
    };
    void check();
    return () => {
      live = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [credential, shareId]);
  // Pasting another guest link into this tab changes only the hash, which does not reload the
  // page; reload so the new invite is read instead of the one already captured.
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {access === "checking" ? (
        <Notice title="Connecting..." />
      ) : access === "name" && credential !== null ? (
        <NameForm
          credential={credential}
          onJoined={() => {
            // The invite is spent; a remount must open the session, not the name form again.
            capturedEntry = { credential: null, shareId };
            setAccess("session");
          }}
        />
      ) : access === "session" && shareId !== null ? (
        <GuestSession shareId={shareId} />
      ) : (
        <Notice
          title="This link has ended or is not valid"
          detail="Ask the owner for a new link."
        />
      )}
    </div>
  );
}

function GuestSession({ shareId }: { readonly shareId: string }) {
  const [stream, dispatch] = useReducer(applyGuestStreamEvent, null, () => ({
    ...initialGuestStreamState,
    awaitingRowIds: readAwaitingRowIds(),
  }));
  useEffect(() => writeAwaitingRowIds(stream.awaitingRowIds), [stream.awaitingRowIds]);
  const [rejected, setRejected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (stream.view) document.title = stream.view.title;
  }, [stream.view]);

  useEffect(
    () =>
      connectGuestStream({
        streamUrl: guestApiUrl(
          `${GUEST_ROUTE_PREFIX}/stream?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
        ),
        sessionUrl: guestApiUrl(
          `${GUEST_ROUTE_PREFIX}/session?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
        ),
        onEvent: dispatch,
        onRejected: () => setRejected(true),
        onReconnecting: setReconnecting,
      }),
    [shareId],
  );

  if (stream.ended || (rejected && stream.view !== null)) {
    return (
      <Notice title="This link has ended" detail="Your access to this conversation has ended." />
    );
  }
  if (stream.view !== null) {
    if (stream.projection === null) return <Notice title="Connecting..." />;
    return (
      <>
        {reconnecting ? (
          <p role="status" className="px-4 py-2 text-center text-xs text-muted-foreground">
            Reconnecting to the conversation…
          </p>
        ) : null}
        <GuestThread
          view={stream.view}
          projection={stream.projection}
          awaitingRowIds={stream.awaitingRowIds}
          hostActivity={stream.hostActivity}
        />
      </>
    );
  }
  if (!rejected) return <Notice title="Connecting..." />;
  return (
    <Notice title="This link has ended or is not valid" detail="Ask the owner for a new link." />
  );
}

function Notice({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="m-auto flex max-w-sm flex-col gap-1 p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function NameForm({
  credential,
  onJoined,
}: {
  readonly credential: string;
  readonly onJoined: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    const failure = await postGuest("redeem", { credential, name: trimmed });
    setSubmitting(false);
    if (failure === null) onJoined();
    else setError(failure);
  };
  return (
    <form className="m-auto flex w-full max-w-xs flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Join a shared mine</h1>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="guest-name">
        Nickname
        <Input
          id="guest-name"
          autoFocus
          autoComplete="name"
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || name.trim() === ""}>
        Join
      </Button>
      <p className="text-xs text-muted-foreground">
        Your nickname is visible to everyone in this conversation.
      </p>
    </form>
  );
}

// The timeline needs an environment id to key its rows. Nothing behind it loads on this page;
// see isGuestPage.
const GUEST_ENVIRONMENT_ID = EnvironmentId.make("guest");
const NO_COMPOSER = createRef<ChatComposerHandle>();
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};

interface GuestMessageEdit {
  readonly message: ThreadGuestMessage;
  readonly text: string;
}

/**
 * The owner's timeline, read-only: every action that would reach the owner's machine (fork,
 * revert, diffs, files, other threads, shell) is left out, so its control does not render.
 */
function GuestThread({
  view: { shareId, title, expiresAt, messages, model, permission, guestId, guests },
  projection,
  awaitingRowIds,
  hostActivity,
}: {
  readonly view: GuestShareView;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly awaitingRowIds: GuestStreamState["awaitingRowIds"];
  readonly hostActivity: GuestStreamState["hostActivity"];
}) {
  // No ":" so the timeline finds no environment thread behind the key.
  const threadKey = `guest-${shareId}`;
  const listRef = useRef<LegendListRef | null>(null);
  const hostKind = useActiveConversationActivity(hostActivity);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState<GuestMessageEdit | null>(null);
  const [deleting, setDeleting] = useState<GuestMessageId | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const activeEdit =
    editing !== null &&
    messages.some(
      (message) =>
        message.id === editing.message.id &&
        message.status === "pending" &&
        message.guestId === guestId,
    )
      ? editing
      : null;
  const beginEdit = (message: ThreadGuestMessage) => {
    setMessageError(null);
    setEditing({ message, text: message.text });
    composerRef.current?.focus();
  };
  const deleteMessage = async (guestMessageId: GuestMessageId, messageId?: MessageId) => {
    if (deleting !== null) return;
    setDeleting(guestMessageId);
    const failure = await postGuest(
      `messages?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
      { shareId, guestMessageId, ...(messageId ? { messageId } : {}), requestId: randomUUID() },
      "DELETE",
    );
    setDeleting(null);
    setMessageError(failure);
    if (failure === null)
      setEditing((current) => (current?.message.id === guestMessageId ? null : current));
  };
  const deleteAction = (guestMessageId: GuestMessageId, messageId?: MessageId) => (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label="Delete your message"
      disabled={deleting !== null}
      onClick={() => void deleteMessage(guestMessageId, messageId)}
    >
      <Trash2Icon />
    </Button>
  );
  const renderMessageActions = (message: ThreadGuestMessage, messageId?: MessageId) =>
    message.guestId !== guestId ? null : (
      <div className="flex items-center gap-0.5">
        {message.status === "pending" && permission !== "viewer" ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Edit your message"
            disabled={deleting !== null}
            onClick={() => beginEdit(message)}
          >
            <PencilIcon />
          </Button>
        ) : null}
        {deleteAction(message.id, messageId)}
      </div>
    );
  const { resolvedTheme } = useTheme();
  // The rest is what ChatView derives from the same projection.
  const [projectQuestionHistory] = useState(() => createQuestionHistoryProjector());
  const items = projectQuestionHistory(projection);
  // Files load through the guest route.
  const [attachmentUrls] = useState(() => createGuestAttachmentUrls(shareId));
  // Expanded rows read detail and command output through the guest routes.
  const [turnItemSource] = useState(() => guestTurnItemSource(shareId));
  const attachmentUrlById = attachmentUrls(items);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: items,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attachmentUrlById,
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const openFile = useStableCallback((file: { readonly id: string }) =>
    openInNewTab(guestAttachmentUrl(shareId, file.id)),
  );
  const activityRun = deriveThreadActivityRun(projection);
  const runtime = deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerRef: NO_COMPOSER,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Not a server thread: new turns follow the end instead of anchoring near the top.
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  const renderHtmlRender = useStableCallback(
    (row: Extract<TimelineRow, { kind: "html-render" }>) => (
      <GuestHtmlRender itemId={row.id} reference={row.htmlRender} shareId={shareId} />
    ),
  );
  const unplaced = unplacedGuestMessages(messages, items, awaitingRowIds);
  // The guest's waiting messages sit in the list footer, which the list does not follow on its
  // own (the owner's view does the same in ChatView). A new one is the guest's own send, so it
  // comes into view even if they had scrolled up, as the owner's send does. While following, the
  // footer stays in view as it grows, such as when its images load.
  const unplacedKey = unplaced.map((message) => message.id).join(",");
  const previousUnplacedKey = useRef(unplacedKey);
  const following = useRef(follow.timelineLiveFollowEnabled);
  const scrollToEnd = useStableCallback(follow.scrollToEnd);
  useEffect(() => {
    following.current = follow.timelineLiveFollowEnabled;
    const previous = new Set(previousUnplacedKey.current.split(","));
    previousUnplacedKey.current = unplacedKey;
    if (unplacedKey.split(",").some((id) => id !== "" && !previous.has(id))) scrollToEnd(true);
  }, [follow.timelineLiveFollowEnabled, unplacedKey, scrollToEnd, following, previousUnplacedKey]);
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        {guests && guests.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="max-w-40 truncate text-xs text-muted-foreground" />}
            >
              {guests.map((guest) => guest.name).join(", ")}
            </TooltipTrigger>
            <TooltipPopup>{guests.map((guest) => guest.name).join(", ")}</TooltipPopup>
          </Tooltip>
        ) : null}
        <ExpiryLabel expiresAt={expiresAt} />
      </header>
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          listRef={listRef}
          timelineEntries={entries}
          isWorking={isWorking}
          activeTurnInProgress={isWorking}
          activeTurnStartedAt={workStartedAt}
          latestRun={activityRun}
          runningRunId={runningRunId}
          turnDiffSummaries={NO_TURN_DIFFS}
          runs={projection.runs}
          routeThreadKey={threadKey}
          onOpenThread={ignore}
          onRollbackCheckpoint={ignore}
          supportsConversationRollback={false}
          onRevertToTurnCount={ignore}
          isRevertingCheckpoint={false}
          onImageExpand={openExpandedImage}
          onFileOpen={openFile}
          onFileDownload={openFile}
          renderHtmlRender={renderHtmlRender}
          renderUserMessageActions={(row) => {
            const attribution = row.message.context?.guest;
            const id = attribution?.guestMessageId;
            const message =
              id === undefined ? undefined : messages.find((candidate) => candidate.id === id);
            if (message) return renderMessageActions(message, row.message.id);
            return attribution &&
              guestId !== undefined &&
              attribution.guestId === guestId &&
              attribution.shareId === shareId
              ? deleteAction(attribution.guestMessageId, row.message.id)
              : null;
          }}
          turnItemSource={turnItemSource}
          activeThreadEnvironmentId={GUEST_ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat="locale"
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={ignore}
          onAnchorSizeChanged={ignore}
          contentInsetEndAdjustment={0}
          emptyPlaceholderInset={0}
          liveFollowEnabled={follow.timelineLiveFollowEnabled}
          onIsAtEndChange={follow.onIsAtEndChangeStable}
          onViewportAttach={follow.attachTimelineViewport}
          onFooterGrow={follow.onTimelineFooterGrowStable}
          footer={
            unplaced.length === 0 && hostKind === "idle" ? null : (
              <div className="chat-content-lane pb-4">
                <ol className="flex flex-col gap-4">
                  {unplaced.map((message) => (
                    <li key={message.id}>
                      <UnplacedGuestMessage
                        shareId={shareId}
                        message={message}
                        guestId={guestId}
                        actions={renderMessageActions(message)}
                      />
                    </li>
                  ))}
                </ol>
                <ConversationActivityBubble kind={hostKind} />
              </div>
            )
          }
        />
        {follow.showScrollToBottom ? (
          <ScrollToEndButton
            summary={null}
            bottom={4}
            onScrollToEnd={() => follow.scrollToEnd(true)}
          />
        ) : null}
      </div>
      <div className={cn(LANE, "shrink-0 pb-4")}>
        {messageError ? (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {messageError}
          </p>
        ) : null}
        {editing !== null && activeEdit === null ? (
          <p role="status" className="pb-2 text-xs text-muted-foreground">
            This message can no longer be edited.
          </p>
        ) : null}
        {permission === "viewer" ? (
          <p className="py-3 text-center text-sm text-muted-foreground">
            Viewer access · You can follow this conversation.
          </p>
        ) : (
          <GuestComposer
            shareId={shareId}
            model={model}
            permission={permission ?? "confirm"}
            textareaRef={composerRef}
            editing={activeEdit}
            latestEditableMessage={latestEditableGuestMessage(messages, guestId)}
            onEditStart={beginEdit}
            onEditTextChange={(text) =>
              setEditing((current) => (current ? { ...current, text } : null))
            }
            onEditEnd={() => setEditing(null)}
          />
        )}
      </div>
    </>
  );
}

function ExpiryLabel({ expiresAt }: { readonly expiresAt: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {formatGuestExpiry(expiresAt, Date.parse(`${nowMinute}Z`))}
    </span>
  );
}

const BUBBLE =
  "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]";

const openInNewTab = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
/** Guests have no image viewer; the browser shows the picture in its own tab. */
const openExpandedImage = (preview: ExpandedImagePreview) => {
  const src = preview.images[preview.index]?.src;
  if (src) openInNewTab(src);
};

/** A guest message the owner has not sent yet, or chose not to send. */
function UnplacedGuestMessage({
  shareId,
  message,
  guestId,
  actions,
}: {
  readonly shareId: GuestShareView["shareId"];
  readonly message: ThreadGuestMessage;
  readonly guestId: string | undefined;
  readonly actions: React.ReactNode;
}) {
  // A dismissed message's files are deleted, so only their names remain.
  const served = message.status !== "dismissed";
  const url = (attachment: { readonly id: string }) => guestAttachmentUrl(shareId, attachment.id);
  return (
    <div className="flex flex-col items-end gap-1">
      <GuestMessageName
        name={
          message.guestId === undefined || message.guestId === guestId
            ? "You"
            : (message.guestName ?? "Guest")
        }
      />
      <div
        className={cn(
          BUBBLE,
          guestBubbleClassName(message.status !== "sent"),
          message.status === "dismissed" ? "text-muted-foreground" : "text-message-foreground",
        )}
      >
        <GuestMessageAttachments
          attachments={message.attachments ?? []}
          imageUrl={(attachment) => (served ? url(attachment) : undefined)}
          onOpenImage={(attachment) => openInNewTab(url(attachment))}
          {...(served ? { fileHref: url } : {})}
        />
        {message.text ? <span>{message.text}</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <p className="me-1 text-2xs text-muted-foreground">
          {STATUS_LABEL[message.status]}
          {message.editedAt ? " · Edited" : ""}
        </p>
        {actions}
      </div>
    </div>
  );
}

/** The thread's model, labeled as the owner's composer labels it, with no way to change it. */
function GuestModelLabel({ model }: { readonly model: GuestThreadModel }) {
  const label = getTriggerDisplayModelName({ slug: model.name, ...model });
  return (
    <ComposerControl
      render={<span />}
      aria-label={`Model: ${label}`}
      className="pointer-events-none min-w-0 shrink"
    >
      {model.driver === null ? null : (
        <ProviderInstanceIcon
          driverKind={model.driver}
          displayName={label}
          className="size-4"
          iconClassName="size-4"
        />
      )}
      <span className="min-w-0 truncate" data-chat-provider-model-picker-label="true">
        {label}
      </span>
    </ComposerControl>
  );
}

interface StagedFile {
  readonly key: string;
  readonly file: File;
}

/** A staged image's thumbnail; its object URL lives as long as the element. */
function StagedImage({ file }: { readonly file: File }) {
  return (
    <img
      alt={file.name}
      className="size-full object-cover"
      ref={(image) => {
        if (!image) return;
        const url = URL.createObjectURL(file);
        image.src = url;
        return () => URL.revokeObjectURL(url);
      }}
    />
  );
}

function GuestComposer({
  shareId,
  model,
  permission,
  textareaRef,
  editing,
  latestEditableMessage,
  onEditStart,
  onEditTextChange,
  onEditEnd,
}: {
  readonly shareId: GuestShareView["shareId"];
  readonly model: GuestThreadModel;
  readonly permission: "confirm" | "send";
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly editing: GuestMessageEdit | null;
  readonly latestEditableMessage: ThreadGuestMessage | null;
  readonly onEditStart: (message: ThreadGuestMessage) => void;
  readonly onEditTextChange: (text: string) => void;
  readonly onEditEnd: () => void;
}) {
  const [draftText, setText] = useState("");
  const text = editing?.text ?? draftText;
  const [files, setFiles] = useState<ReadonlyArray<StagedFile>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activity = useConversationActivityPublisher({
    targetKey: `guest:${shareId}`,
    publish: (kind) =>
      postGuest(`activity?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`, { shareId, kind }),
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextFileKey = useRef(0);
  const submissionRef = useRef<{
    readonly text: string;
    readonly files: ReadonlyArray<StagedFile>;
    readonly requestId: string;
  } | null>(null);
  const editSubmissionRef = useRef<GuestEditRequest | null>(null);
  const { resolvedTheme } = useTheme();
  const addFiles = (added: ReadonlyArray<File>) => {
    if (added.length === 0 || editing !== null) return;
    const next = [
      ...files,
      ...added.map((file) => ({ key: `staged-${nextFileKey.current++}`, file })),
    ];
    const problem = guestFilesProblem(next.map((staged) => staged.file));
    setError(problem);
    if (problem === null) setFiles(next);
  };
  const send = async () => {
    const trimmed = text.trim();
    const attachments = editing === null ? files : (editing.message.attachments ?? []);
    if ((trimmed === "" && attachments.length === 0) || sending) return;
    activity.clear();
    setSending(true);
    if (editing !== null) {
      const previous = editSubmissionRef.current;
      const request =
        previous?.guestMessageId === editing.message.id &&
        previous.text === trimmed &&
        previous.expectedRevision === (editing.message.revision ?? 0)
          ? previous
          : {
              shareId,
              guestMessageId: editing.message.id,
              text: trimmed,
              expectedRevision: editing.message.revision ?? 0,
              requestId: randomUUID(),
            };
      editSubmissionRef.current = request;
      const failure = await postGuest(
        `messages?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
        request,
        "PATCH",
      );
      setSending(false);
      setError(failure);
      if (failure === null) {
        editSubmissionRef.current = null;
        onEditEnd();
      }
      return;
    }
    const sentFiles = files;
    const previous = submissionRef.current;
    const requestId =
      previous?.text === trimmed &&
      previous.files.length === sentFiles.length &&
      previous.files.every((file, index) => file === sentFiles[index])
        ? previous.requestId
        : randomUUID();
    submissionRef.current = { text: trimmed, files: sentFiles, requestId };
    const form = new FormData();
    form.append("shareId", shareId);
    form.append("text", trimmed);
    form.append("requestId", requestId);
    for (const staged of sentFiles) form.append("file", staged.file, staged.file.name);
    const failure = await postGuest(
      `messages?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
      form,
    );
    setSending(false);
    setError(failure);
    // Keep anything typed or attached while the request was in flight.
    if (failure === null) {
      submissionRef.current = null;
      setText((current) => (current.trim() === trimmed ? "" : current));
      setFiles((current) => current.filter((staged) => !sentFiles.includes(staged)));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && editing !== null) {
      event.preventDefault();
      if (!sending) onEditEnd();
      return;
    }
    if (
      event.key === "ArrowUp" &&
      editing === null &&
      text === "" &&
      files.length === 0 &&
      latestEditableMessage !== null &&
      !sending
    ) {
      event.preventDefault();
      setError(null);
      onEditStart(latestEditableMessage);
      return;
    }
    // Same as the app composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  // As in the app composer: pasted images attach, and other files attach when no text came along.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    const hasImage = pasted.some((file) => file.type.startsWith("image/"));
    if (pasted.length === 0 || (!hasImage && event.clipboardData.getData("text/plain") !== "")) {
      return;
    }
    event.preventDefault();
    addFiles(pasted);
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-3xl border border-border bg-card px-4 pt-3 pb-2.5 shadow-composer dark:shadow-composer-dark"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {editing !== null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <PencilIcon aria-hidden className="size-3" />
          <span className="flex-1">Editing your message · Awaiting approval</span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Cancel editing"
            disabled={sending}
            onClick={onEditEnd}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {editing !== null && (editing.message.attachments?.length ?? 0) > 0 ? (
        <GuestMessageAttachments
          attachments={editing.message.attachments ?? []}
          imageUrl={(attachment) => guestAttachmentUrl(shareId, attachment.id)}
          fileHref={(attachment) => guestAttachmentUrl(shareId, attachment.id)}
          onOpenImage={(attachment) => openInNewTab(guestAttachmentUrl(shareId, attachment.id))}
        />
      ) : null}
      {editing === null && files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached files">
          {files.map((staged) => (
            <li
              key={staged.key}
              className="flex h-14 min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/80 bg-background/70 pe-1"
            >
              {staged.file.type.startsWith("image/") ? (
                <span className="size-14 shrink-0">
                  <StagedImage file={staged.file} />
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-2 ps-2 text-sm">
                  <PierreEntryIcon pathValue={staged.file.name} kind="file" theme={resolvedTheme} />
                  <span className="max-w-40 truncate">{staged.file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatAttachmentSize(staged.file.size)}
                  </span>
                </span>
              )}
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${staged.file.name}`}
                onClick={() => {
                  setError(null);
                  setFiles((current) => current.filter((candidate) => candidate !== staged));
                }}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        aria-label="Message"
        placeholder={editing === null ? "Message" : "Edit your message"}
        rows={2}
        maxLength={GUEST_MESSAGE_MAX_LENGTH}
        value={text}
        disabled={editing !== null && sending}
        onChange={(event) => {
          activity.typing();
          if (editing === null) setText(event.target.value);
          else onEditTextChange(event.target.value);
        }}
        onBlur={activity.clear}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-sm outline-none field-sizing-content placeholder:text-placeholder"
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            // The same file can be picked again after it is removed.
            event.target.value = "";
          }}
        />
        <ComposerControl
          aria-label="Attach files"
          disabled={editing !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          <ComposerControlIcon icon={PaperclipIcon} />
        </ComposerControl>
        <GuestModelLabel model={model} />
        {error !== null ? (
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {permission === "send"
              ? "Messages go straight to the agent"
              : "The owner approves each message"}
          </p>
        )}
        <button
          type="submit"
          aria-label={editing === null ? "Send" : "Save edit"}
          disabled={
            sending ||
            (text.trim() === "" &&
              (editing === null ? files.length : (editing.message.attachments?.length ?? 0)) === 0)
          }
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64"
        >
          {editing === null ? (
            <ArrowUpIcon aria-hidden className="size-4" />
          ) : (
            <CheckIcon aria-hidden className="size-4" />
          )}
        </button>
      </div>
    </form>
  );
}
