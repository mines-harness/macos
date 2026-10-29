import { useStableCallback } from "../../hooks/useStableCallback";
import type { LegendListRef } from "@legendapp/list/react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { SharedContactGroup } from "@t3tools/contracts/contacts";
import type { SharedGroupView } from "@t3tools/contracts/sharedGroups";
import { PlusIcon, RefreshCwIcon, BotMessageSquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { useQuietThreadShells } from "../../state/entities";
import { readPeerConnectionState } from "../../state/peers";
import { checkSharedGroupHost } from "./sharedGroupHost";
import { useEnvironmentQuery } from "../../state/query";
import {
  sharedGroupAddChats,
  sharedGroupRemoveChats,
  sharedGroupSend,
  sharedGroupSubscription,
  sharedGroupPublishActivity,
  sharedGroupActivitySubscription,
} from "../../state/sharedGroups";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConversationActivityPublisher } from "../../hooks/useConversationActivity";
import { ConversationActivityIndicator } from "../chat/ConversationActivity";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPopup,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { GroupMessageComposer, type GroupComposerMessage } from "../groups/GroupMessageComposer";
import { GroupConversationSidebar } from "../groups/GroupConversationSidebar";
import { GroupConversationTimeline } from "../groups/GroupConversationTimeline";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ContactAvatar } from "./ContactsPage";
import { useContacts } from "./ContactsProvider";
import { sharedChatMembers } from "./SharedGroupConversation.logic";

const SharedMessageDraft = Schema.Struct({ text: Schema.String, requestId: Schema.String });

function SharedChatPicker({
  group,
  environmentId,
  view,
  onClose,
  onSaved,
}: {
  readonly group: SharedContactGroup;
  readonly environmentId: EnvironmentId;
  readonly view: SharedGroupView;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const allThreads = useQuietThreadShells();
  const selectedIds = new Set(view.selectedThreadIds);
  const threads = allThreads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !selectedIds.has(thread.id),
  );
  const [chosen, setChosen] = useState<ReadonlySet<ThreadId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(randomUUID);
  const add = useAtomCommand(sharedGroupAddChats, { reportFailure: false });
  const readConnection = useAtomCommand(readPeerConnectionState, { reportFailure: false });
  const { userId } = useMinesAuth();
  const allowed = useAtomValue(sharedGroupAddChats.permissionAtom(environmentId));
  const capacity = Math.max(0, 12 - (view.snapshot?.members.length ?? 0));
  const submit = async () => {
    if (busy || !allowed || chosen.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await checkSharedGroupHost(environmentId, userId, readConnection);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your computer’s account could not be checked.",
      );
      setBusy(false);
      return;
    }
    const result = await add({
      environmentId,
      input: {
        groupKey: group.key,
        coordinatorDeviceId: group.coordinatorDeviceId,
        members: sharedChatMembers(
          threads.filter((thread) => chosen.has(thread.id)),
          view.snapshot?.members.map((member) => member.alias) ?? [],
        ),
        clientRequestId: requestId,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onSaved();
      onClose();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The chats could not be added.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Bring your chats</DialogTitle>
          <DialogDescription>
            Choose chats from your computer. Only the chats you add join this group.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other chats are available on this computer.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {threads.map((thread) => (
                <label
                  key={thread.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(thread.id)}
                    disabled={busy || (!chosen.has(thread.id) && chosen.size >= capacity)}
                    onChange={() =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (next.has(thread.id)) next.delete(thread.id);
                        else next.add(thread.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 truncate text-sm">{thread.title}</span>
                </label>
              ))}
            </div>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost-muted" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !allowed || chosen.size === 0 || chosen.size > capacity}
            onClick={() => void submit()}
          >
            <PlusIcon />
            {busy ? "Adding…" : `Add ${chosen.size || ""} ${chosen.size === 1 ? "chat" : "chats"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SharedGroupConversation({
  group,
  environmentId,
  renderUsers,
}: {
  readonly group: SharedContactGroup;
  readonly environmentId: EnvironmentId;
  readonly renderUsers?: (onChanged: () => void) => ReactNode;
}) {
  const address = { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId };
  const query = useEnvironmentQuery(sharedGroupSubscription({ environmentId, input: address }));
  const membershipRevision = JSON.stringify([
    group.members.map((member) => member.friendId).toSorted(),
    group.memberships.map((member) => [member.friendId, member.invitationId]).toSorted(),
  ]);
  const previousMembership = useRef(membershipRevision);
  const refreshGroup = query.refresh;
  // oxlint-disable-next-line mines/react-effect-budget -- Refresh host membership when the control service reports a changed group roster.
  useEffect(() => {
    if (previousMembership.current === membershipRevision) return;
    previousMembership.current = membershipRevision;
    refreshGroup();
  }, [membershipRevision, refreshGroup]);
  const view = query.data;
  const snapshot = view?.snapshot;
  const { data } = useContacts();
  const { userId } = useMinesAuth();
  const send = useAtomCommand(sharedGroupSend, { reportFailure: false });
  const readConnection = useAtomCommand(readPeerConnectionState, { reportFailure: false });
  const remove = useAtomCommand(sharedGroupRemoveChats, { reportFailure: false });
  const canSend = useAtomValue(sharedGroupSend.permissionAtom(environmentId));
  const canAdd = useAtomValue(sharedGroupAddChats.permissionAtom(environmentId));
  const canRemove = useAtomValue(sharedGroupRemoveChats.permissionAtom(environmentId));
  const [initialDraft] = useState(() => ({ text: "", requestId: randomUUID() }));
  const [draft, setDraft] = useLocalStorage(
    `mines:shared-group-message:${JSON.stringify([userId, environmentId, group.key])}`,
    initialDraft,
    SharedMessageDraft,
  );
  const editorRef = useRef<ChatComposerHandle>(null);
  const timelineRef = useRef<LegendListRef | null>(null);
  const navigate = useNavigate();
  const addDroppedFiles = useStableCallback((files: File[]) =>
    editorRef.current?.addDroppedFiles(files),
  );
  const addDroppedFolders = useStableCallback((folders: File[]) =>
    editorRef.current?.addDroppedFolders(folders),
  );
  const fileDrop = makeWorkspaceFileDropHandlers({
    setDragActive: () => {},
    addFiles: addDroppedFiles,
    addFolders: addDroppedFolders,
  });
  const [askAi, setAskAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const online = view?.status === "online" && snapshot !== null && snapshot !== undefined;
  const publishActivity = useAtomCommand(sharedGroupPublishActivity, { reportFailure: false });
  const liveActivity = useEnvironmentQuery(
    online ? sharedGroupActivitySubscription({ environmentId, input: address }) : null,
  );
  const activity = useConversationActivityPublisher({
    targetKey: JSON.stringify([userId, environmentId, group.key]),
    enabled: online && canSend,
    publish: (kind) => publishActivity({ environmentId, input: { ...address, kind } }),
  });
  const reportDraftActivity = (kind: "typing" | "voice" | "idle") => {
    if (kind === "typing") activity.typing();
    else if (kind === "voice") activity.voice(true);
    else {
      activity.voice(false);
      activity.clear();
    }
  };
  const hasAiChats = (snapshot?.members.length ?? 0) > 0;
  const effectiveAskAi = askAi && hasAiChats;
  const submit = async (requestAiResponse: boolean, payload: GroupComposerMessage) => {
    if (
      (!payload.message.trim() &&
        !payload.attachments?.length &&
        !payload.context?.records.length) ||
      busy ||
      !online ||
      !canSend
    )
      return false;
    if (payload.message.length > 120_000) {
      setError(
        "Group messages can contain up to 120,000 characters. Shorten your draft to send it.",
      );
      return false;
    }
    if (requestAiResponse && !hasAiChats) {
      setError("Bring a chat to the group before asking AI.");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await checkSharedGroupHost(environmentId, userId, readConnection);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your computer’s account could not be checked.",
      );
      setBusy(false);
      return false;
    }
    const result = await send({
      environmentId,
      input: {
        ...address,
        ...payload,
        requestAiResponse,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setAskAi(false);
      query.refresh();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "Your message could not be sent. Your draft is saved.",
      );
    }
    return result._tag === "Success";
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      aria-label="Shared conversation"
      onDragEnter={fileDrop.onDragEnter}
      onDragOver={fileDrop.onDragOver}
      onDragLeave={fileDrop.onDragLeave}
      onDrop={fileDrop.onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-medium">Conversation</h2>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Reconnect shared conversation"
          onClick={query.refresh}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!online || !canAdd || busy}
          onClick={() => setPicking(true)}
        >
          <PlusIcon />
          Bring your chats
        </Button>
      </div>
      {query.isPending && !view ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connecting to the group…
        </p>
      ) : null}
      {view?.status === "offline" ? (
        <p role="status" className="text-sm text-muted-foreground">
          The group’s computer is offline or a direct connection is unavailable. Reconnect to send
          messages.
        </p>
      ) : null}
      {query.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {snapshot ? (
          <GroupConversationTimeline
            key={`${environmentId}:${snapshot.group.id}`}
            environmentId={environmentId}
            coordinatorEnvironmentId={EnvironmentId.make(group.coordinatorEnvironmentId)}
            snapshot={snapshot}
            sharedAddress={{ groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId }}
            listRef={timelineRef}
            footer={liveActivity.data?.participants
              .filter((participant) => participant.friendId !== data?.profile.friendId)
              .map((participant) => (
                <div key={participant.friendId} className="chat-content-lane py-1">
                  <ConversationActivityIndicator
                    activity={participant}
                    name={
                      group.members.find((member) => member.friendId === participant.friendId)
                        ?.displayName ?? "Group member"
                    }
                  />
                </div>
              ))}
            authorNames={
              new Map(group.members.map((member) => [member.friendId, member.displayName]))
            }
            onCiteAssistantText={(citation, anchor) =>
              editorRef.current?.citeAssistantText(citation, anchor) ?? false
            }
            onOpenThread={(ref) => void navigate({ to: "/$environmentId/$threadId", params: ref })}
          />
        ) : (
          <div className="min-h-0 flex-1 px-4 py-4 text-sm text-muted-foreground">
            Connecting to the group…
          </div>
        )}
        <GroupConversationSidebar
          snapshot={snapshot ?? null}
          onMention={(alias) => {
            editorRef.current?.insertTextAtEnd(`@${alias} `, { ensureLeadingBoundary: true });
            editorRef.current?.focusAtEnd();
          }}
          users={
            renderUsers
              ? renderUsers(query.refresh)
              : group.members.map((member) => (
                  <div key={member.friendId} className="flex items-center gap-3">
                    <ContactAvatar profile={member} />
                    <span className="min-w-0 truncate text-sm">
                      {member.displayName}
                      {member.friendId === data?.profile.friendId ? " (you)" : ""}
                    </span>
                  </div>
                ))
          }
          renderMineActions={(member) =>
            view?.selectedThreadIds.includes(member.threadId) &&
            (member.environmentId === null || member.environmentId === environmentId) ? (
              <Button
                size="icon-tiny"
                variant="ghost-muted"
                aria-label={`Remove your chat ${member.alias}`}
                disabled={busy || !online || !canRemove}
                onClick={() => {
                  setBusy(true);
                  void checkSharedGroupHost(environmentId, userId, readConnection)
                    .then(() =>
                      remove({
                        environmentId,
                        input: { ...address, threadIds: [member.threadId] },
                      }),
                    )
                    .then(
                      (result) => {
                        setBusy(false);
                        if (result._tag === "Success") query.refresh();
                        else {
                          const cause = squashAtomCommandFailure(result);
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "The chat could not be removed.",
                          );
                        }
                      },
                      (cause: unknown) => {
                        setBusy(false);
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Your computer’s account could not be checked.",
                        );
                      },
                    );
                }}
              >
                <XIcon />
              </Button>
            ) : null
          }
        />
      </div>
      <div className="shrink-0">
        <GroupMessageComposer
          environmentId={environmentId}
          snapshot={snapshot ?? null}
          {...(data?.profile.friendId ? { authorFriendId: data.profile.friendId } : {})}
          getTimelineScrollableNode={() => timelineRef.current?.getScrollableNode() ?? null}
          isSendBusy={busy}
          onDraftActivity={reportDraftActivity}
          submissionKey={String(effectiveAskAi)}
          onPlanModeChange={(active) => {
            if (active) setAskAi(true);
          }}
          onOpenMember={(member) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: member.threadId },
            })
          }
          canOpenMember={(member) => view?.selectedThreadIds.includes(member.threadId) ?? false}
          sendDisabledReason={
            !online
              ? "Reconnect to the group to send."
              : !canSend
                ? "This connection cannot send to this group."
                : null
          }
          editorRef={editorRef}
          draftKey={JSON.stringify([userId, environmentId, group.key])}
          ariaLabel="Message your group"
          placeholder="Message your group…"
          value={draft.text}
          disabled={busy}
          submitOnEnter
          onChange={(text) => {
            setDraft((current) =>
              current.text === text ? current : { text, requestId: randomUUID() },
            );
          }}
          onSubmit={(alternate, payload) => submit(effectiveAskAi || alternate, payload)}
        >
          <Button
            size="sm"
            variant={effectiveAskAi ? "secondary" : "ghost-muted"}
            aria-pressed={effectiveAskAi}
            disabled={busy || !hasAiChats}
            onClick={() => setAskAi((current) => !current)}
          >
            <BotMessageSquareIcon />
            Ask AI
          </Button>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {hasAiChats
              ? "Turn on Ask AI when you want a mine to respond."
              : "Bring a chat to enable Ask AI."}
          </span>
        </GroupMessageComposer>
      </div>
      {picking && view ? (
        <SharedChatPicker
          group={group}
          environmentId={environmentId}
          view={view}
          onClose={() => setPicking(false)}
          onSaved={query.refresh}
        />
      ) : null}
    </section>
  );
}
