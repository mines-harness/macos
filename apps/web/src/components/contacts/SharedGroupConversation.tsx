import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SharedContactGroup } from "@t3tools/contracts/contacts";
import type { SharedGroupView } from "@t3tools/contracts/sharedGroups";
import { ArrowUpIcon, PlusIcon, RefreshCwIcon, BotMessageSquareIcon, XIcon } from "lucide-react";
import { useState } from "react";
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
} from "../../state/sharedGroups";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Textarea } from "../ui/textarea";
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
}: {
  readonly group: SharedContactGroup;
  readonly environmentId: EnvironmentId;
}) {
  const address = { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId };
  const query = useEnvironmentQuery(sharedGroupSubscription({ environmentId, input: address }));
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
  const [askAi, setAskAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const online = view?.status === "online" && snapshot !== null && snapshot !== undefined;
  const profiles = new Map(group.members.map((member) => [member.friendId, member]));
  const hasAiChats = (snapshot?.members.length ?? 0) > 0;
  const effectiveAskAi = askAi && hasAiChats;
  const submit = async (requestAiResponse = effectiveAskAi) => {
    if (!draft.text.trim() || busy || !online || !canSend) return;
    if (requestAiResponse && !hasAiChats) {
      setError("Bring a chat to the group before asking AI.");
      return;
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
      return;
    }
    const requestId = draft.requestId;
    const result = await send({
      environmentId,
      input: {
        ...address,
        message: draft.text.trim(),
        clientRequestId: requestId,
        requestAiResponse,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDraft((current) =>
        current.requestId === requestId ? { text: "", requestId: randomUUID() } : current,
      );
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
  };
  return (
    <section className="flex flex-col gap-4" aria-label="Shared conversation">
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
      {snapshot?.members.length ? (
        <div className="flex flex-wrap gap-2" aria-label="Chats in this group">
          {snapshot.members.map((member) => (
            <span
              key={member.id}
              className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs"
            >
              <span>@{member.alias}</span>
              {view?.selectedThreadIds.includes(member.threadId) &&
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
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className="flex min-h-40 flex-col gap-5 rounded-xl border border-border/70 p-4"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {snapshot?.messages.map((message) => {
          const author = message.authorFriendId ? profiles.get(message.authorFriendId) : undefined;
          const label = message.memberId
            ? (snapshot.members.find((member) => member.id === message.memberId)?.alias ?? "Mine")
            : message.authorFriendId === data?.profile.friendId
              ? "You"
              : (author?.displayName ?? "Group member");
          return (
            <article key={message.id} className="flex items-start gap-3">
              {author ? <ContactAvatar profile={author} /> : null}
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {message.text}
                </p>
              </div>
            </article>
          );
        })}
        {online && snapshot?.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Start a conversation. AI stays quiet until you ask.
          </p>
        ) : null}
      </div>
      <form
        className="flex flex-col gap-2 rounded-xl border border-border/70 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          aria-label="Message your group"
          placeholder="Message your group…"
          value={draft.text}
          disabled={busy}
          maxLength={120_000}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft((current) =>
              current.text === text ? current : { text, requestId: randomUUID() },
            );
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit(effectiveAskAi || event.metaKey || event.ctrlKey);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
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
          <Button
            type="submit"
            size="icon"
            aria-label={effectiveAskAi ? "Send and ask AI" : "Send message"}
            disabled={!draft.text.trim() || busy || !online || !canSend}
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
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
