import { catalogHostId, minesAccountEnvironmentIdsAtom } from "@t3tools/client-runtime/catalog";
import { useMinesCatalog } from "../../catalog/useMinesCatalog";
import { useAtomValue } from "@effect/atom-react";
import { randomUUID } from "../../lib/utils";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { EnvironmentId, GroupId, GroupWorkflow, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { groupHostRoutes } from "../../state/groupHostRoutes";
import { ArrowUpIcon, UsersIcon, SquareIcon } from "lucide-react";
import {
  groupCreate,
  groupArchive,
  groupSend,
  groupStop,
  groupRetry,
  groupSubscription,
} from "../../state/groups";
import { useEnvironmentQuery } from "../../state/query";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useThreadShells } from "../../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SidebarInset } from "../ui/sidebar";
import { groupRecipients } from "@t3tools/client-runtime/group-chat";
import { refreshGroupMemberships } from "../../state/groupMemberships";
import { GroupParticipantsControl } from "./GroupParticipantsControl";

export const GROUP_WORKFLOWS: ReadonlyArray<{
  id: GroupWorkflow;
  label: string;
  description: string;
}> = [
  {
    id: "team",
    label: "Team",
    description: "A persistent group of mines, with shared messages and explicit invitations.",
  },
  {
    id: "compare",
    label: "Compare",
    description: "Independent answers. Choose a result to continue.",
  },
  {
    id: "build-review",
    label: "Build + review",
    description: "A builder, parallel reviewers, then one correction pass.",
  },
  {
    id: "council",
    label: "Council",
    description: "Parallel answers, a critique round, then a synthesis from your lead.",
  },
];

const DraftMember = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  alias: Schema.String,
  role: Schema.String,
});
type DraftMember = typeof DraftMember.Type;
const GroupSetupDraft = Schema.Struct({
  name: Schema.String,
  workflow: GroupWorkflow,
  members: Schema.Array(DraftMember),
  leadKey: Schema.String,
  requestId: Schema.String,
});
type GroupSetupDraft = typeof GroupSetupDraft.Type;
const GroupMessageDraft = Schema.Struct({ text: Schema.String, requestId: Schema.String });
const memberKey = (member: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) => JSON.stringify([member.environmentId, member.threadId]);
function suggestedAlias(title: string, members: ReadonlyArray<DraftMember>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 24) || "member";
  let value = base === "everyone" ? "teammate" : base;
  let suffix = 2;
  while (members.some((member) => member.alias.toLowerCase() === value))
    value = `${base}-${suffix++}`;
  return value;
}

export function GroupWorkspace({
  environmentId: rawEnvironmentId,
  groupId: rawGroupId,
}: {
  environmentId: string;
  groupId: string;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const isNew = rawGroupId === "new";
  const groupId = GroupId.make(rawGroupId);
  const environment = useEnvironment(environmentId);
  const { catalog, accountId } = useMinesCatalog();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const ownedEnvironmentIds = useAtomValue(minesAccountEnvironmentIdsAtom);
  const owned = environmentId === primaryEnvironmentId || ownedEnvironmentIds.has(environmentId);
  const query = useEnvironmentQuery(
    isNew ? null : groupSubscription({ environmentId, input: { groupId } }),
  );
  const create = useOrchestrationCommand(groupCreate);
  const send = useOrchestrationCommand(groupSend);
  const stop = useOrchestrationCommand(groupStop);
  const retry = useOrchestrationCommand(groupRetry);
  const archive = useOrchestrationCommand(groupArchive);
  const archiveAllowed = useAtomValue(groupArchive.permissionAtom(environmentId));
  const sendAllowed = useAtomValue(groupSend.permissionAtom(environmentId));
  const stopAllowed = useAtomValue(groupStop.permissionAtom(environmentId));
  const retryAllowed = useAtomValue(groupRetry.permissionAtom(environmentId));
  const navigate = useNavigate();
  const allThreads = useThreadShells();
  const { environments } = useEnvironments();
  const hostRoutes = useEnvironmentQuery(
    isNew ? groupHostRoutes({ environmentId, input: {} }) : null,
  );
  const routedHosts = new Set(hostRoutes.data?.routes.map((route) => route.environmentId) ?? []);
  const connectedHosts = new Set(
    environments
      .filter((host) => host.connection.phase === "connected")
      .map((host) => host.environmentId),
  );
  const threads = allThreads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      (thread.environmentId === environmentId ||
        (routedHosts.has(thread.environmentId) && connectedHosts.has(thread.environmentId))),
  );
  const [initialSetup] = useState<GroupSetupDraft>(() => ({
    name: "",
    workflow: "team",
    members: [],
    leadKey: "",
    requestId: randomUUID(),
  }));
  const [setup, setSetup] = useLocalStorage(
    `mines:group-setup:${JSON.stringify([accountId, environmentId])}`,
    initialSetup,
    GroupSetupDraft,
  );
  const [initialMessage] = useState(() => ({ text: "", requestId: randomUUID() }));
  const [draft, setDraft] = useLocalStorage(
    `mines:group-message:${JSON.stringify([accountId, environmentId, groupId])}`,
    initialMessage,
    GroupMessageDraft,
  );
  const prompt = draft.text;
  const setPrompt = (value: string | ((previous: string) => string)) =>
    setDraft((current) => ({
      text: typeof value === "function" ? value(current.text) : value,
      requestId: randomUUID(),
    }));
  const updateSetup = (
    value: Partial<GroupSetupDraft> | ((current: GroupSetupDraft) => Partial<GroupSetupDraft>),
  ) =>
    setSetup((current) => ({
      ...current,
      ...(typeof value === "function" ? value(current) : value),
      requestId: randomUUID(),
    }));
  const selectedKeys = new Set(setup.members.map(memberKey));
  const availableKeys = new Set(
    threads.map((thread) =>
      memberKey({ environmentId: thread.environmentId, threadId: thread.id }),
    ),
  );
  const aliasesValid =
    setup.members.every(
      (member) =>
        /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(member.alias) &&
        member.alias.toLowerCase() !== "everyone",
    ) &&
    new Set(setup.members.map((member) => member.alias.toLowerCase())).size ===
      setup.members.length;
  const selectedAvailable = setup.members.every((member) => availableKeys.has(memberKey(member)));
  const lead =
    setup.members.find((member) => memberKey(member) === setup.leadKey) ?? setup.members[0];
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = query.data;
  useEffect(() => {
    if (snapshot && catalog && owned && snapshot.group.visibility !== "shared")
      catalog.upsert({
        id: catalogHostId("group", environmentId, snapshot.group.id),
        kind: "group",
        title: snapshot.group.name,
        hostRef: { environmentId, entityId: snapshot.group.id },
      });
  }, [snapshot, catalog, owned, environmentId]);
  const archived = snapshot?.group.archivedAt != null;
  const activeRounds = snapshot?.rounds.filter((round) => round.status === "active") ?? [];
  const submit = async () => {
    if (sending || !prompt.trim() || !snapshot || archived || !sendAllowed) return;
    setSending(true);
    setError(null);
    const addressing = groupRecipients(prompt, snapshot.members);
    const requestId = draft.requestId;
    const result = await send({
      environmentId,
      input: {
        groupId,
        message: prompt,
        clientRequestId: requestId,
        ...(addressing.mentionEveryone
          ? { mentionEveryone: true }
          : addressing.recipientMemberIds.length
            ? { recipientMemberIds: addressing.recipientMemberIds }
            : {}),
      },
    });
    if (result._tag === "Success")
      setDraft((current) =>
        current.requestId === requestId ? { text: "", requestId: randomUUID() } : current,
      );
    else
      setError(
        "The message could not be accepted. Your draft is saved here; check the device connection before retrying.",
      );
    setSending(false);
  };
  return (
    <SidebarInset>
      <main className="flex h-dvh min-h-0 flex-1 flex-col bg-background text-foreground">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-6">
          <UsersIcon className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              {isNew ? "Create a group" : (snapshot?.group.name ?? "Group")}
            </h1>
            {snapshot ? (
              <GroupParticipantsControl
                key={`${environmentId}:${snapshot.group.id}`}
                environmentId={environmentId}
                snapshot={snapshot}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Coordinator · {environment?.label ?? "Saved computer"}
            </p>
          </div>
          {snapshot ? (
            <Button
              variant="outline"
              size="sm"
              disabled={sending || !archiveAllowed}
              onClick={() => {
                void archive({ environmentId, input: { groupId, archived: !archived } }).then(
                  (result) => {
                    if (result._tag === "Success") refreshGroupMemberships(environmentId);
                  },
                );
              }}
            >
              {archived ? "Reopen group" : "Archive group"}
            </Button>
          ) : null}
          {activeRounds.length ? (
            <Button
              variant="outline"
              size="sm"
              disabled={sending || !stopAllowed}
              onClick={() => void stop({ environmentId, input: { groupId } })}
            >
              <SquareIcon />
              Stop
            </Button>
          ) : null}
        </header>
        {archived ? (
          <p role="status" className="px-6 py-3 text-sm text-muted-foreground">
            This group is archived. Its member mines are available for other groups. Reopen it to
            send messages.
          </p>
        ) : null}
        {isNew ? (
          <section className="mx-auto w-full max-w-2xl space-y-7 overflow-y-auto scrollbar-gutter-both px-6 py-10">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Bring your mines together.</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Each participant keeps its model, account, workspace, and memory. Only messages sent
                through this group are shared automatically.
              </p>
            </div>
            <label className="block space-y-2 text-sm">
              Group name
              <Input
                value={setup.name}
                onChange={(event) => updateSetup({ name: event.target.value })}
                placeholder="Launch planning"
                maxLength={120}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Workflow</legend>
              {GROUP_WORKFLOWS.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors duration-150 hover:bg-accent"
                >
                  <input
                    type="radio"
                    className="mt-1 accent-foreground"
                    name="workflow"
                    checked={setup.workflow === option.id}
                    onChange={() => updateSetup({ workflow: option.id })}
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Choose existing mines</legend>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Connected computers with group access appear here. Set up both directions in
                Settings → Connections → Groups across computers. The coordinator and member
                computers must stay awake.
              </p>
              {threads.map((thread) => {
                const key = memberKey({ environmentId: thread.environmentId, threadId: thread.id });
                const selected = selectedKeys.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="accent-foreground"
                      checked={selected}
                      disabled={!selected && setup.members.length >= 12}
                      onChange={() =>
                        updateSetup((current) => {
                          const members = selected
                            ? current.members.filter((member) => memberKey(member) !== key)
                            : [
                                ...current.members,
                                {
                                  environmentId: thread.environmentId,
                                  threadId: thread.id,
                                  title: thread.title,
                                  alias: suggestedAlias(thread.title, current.members),
                                  role: "",
                                },
                              ];
                          return {
                            members,
                            leadKey: members.some((member) => memberKey(member) === current.leadKey)
                              ? current.leadKey
                              : members[0]
                                ? memberKey(members[0])
                                : "",
                          };
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{thread.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {environments.find((host) => host.environmentId === thread.environmentId)
                          ?.label ?? "Computer"}{" "}
                        · {thread.modelSelection.model}
                      </span>
                    </span>
                  </label>
                );
              })}
              {threads.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Start a mine on this computer, or connect another computer and its existing mines.
                </p>
              ) : null}
            </fieldset>
            {setup.members.length ? (
              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-medium">
                  Name your team and choose a lead
                </legend>
                {setup.members.map((member) => {
                  const key = memberKey(member);
                  return (
                    <div key={key} className="space-y-3 rounded-xl border border-border p-4">
                      <div className="flex items-center gap-3">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">
                          {member.title}
                        </p>
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="radio"
                            name="group-lead"
                            checked={lead !== undefined && memberKey(lead) === key}
                            onChange={() => updateSetup({ leadKey: key })}
                          />
                          Lead
                        </label>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            updateSetup({
                              members: setup.members.filter(
                                (candidate) => memberKey(candidate) !== key,
                              ),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                      <label className="block space-y-1 text-xs">
                        Mention name
                        <Input
                          value={member.alias}
                          maxLength={32}
                          aria-label={`Mention name for ${member.title}`}
                          onChange={(event) =>
                            updateSetup({
                              members: setup.members.map((candidate) =>
                                memberKey(candidate) === key
                                  ? { ...candidate, alias: event.target.value }
                                  : candidate,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="block space-y-1 text-xs">
                        Role <span className="text-muted-foreground">optional</span>
                        <Input
                          value={member.role}
                          maxLength={500}
                          placeholder="Reviews accessibility and interaction design"
                          onChange={(event) =>
                            updateSetup({
                              members: setup.members.map((candidate) =>
                                memberKey(candidate) === key
                                  ? { ...candidate, role: event.target.value }
                                  : candidate,
                              ),
                            })
                          }
                        />
                      </label>
                      {!availableKeys.has(key) ? (
                        <p className="text-xs text-muted-foreground">
                          This mine's computer is disconnected, access is missing, or the mine was
                          archived. Reconnect it or remove this member.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
                {!aliasesValid ? (
                  <p role="status" className="text-xs text-destructive">
                    Use unique mention names starting with a letter; letters, numbers, underscores
                    and hyphens are allowed. Everyone is reserved.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            <Button
              disabled={
                sending ||
                !setup.name.trim() ||
                setup.members.length === 0 ||
                !aliasesValid ||
                !selectedAvailable ||
                (setup.workflow !== "team" && setup.members.length < 2)
              }
              onClick={async () => {
                setSending(true);
                setError(null);
                const result = await create({
                  environmentId,
                  input: {
                    name: setup.name.trim(),
                    workflow: setup.workflow,
                    members: setup.members.map((member) => ({
                      threadId: member.threadId,
                      alias: member.alias,
                      ...(member.role.trim() ? { role: member.role.trim() } : {}),
                      ...(member.environmentId === environmentId
                        ? {}
                        : { environmentId: member.environmentId }),
                    })),
                    ...(lead
                      ? { leadThreadId: lead.threadId, leadEnvironmentId: lead.environmentId }
                      : {}),
                    clientRequestId: setup.requestId,
                  },
                });
                setSending(false);
                if (result._tag === "Success") {
                  refreshGroupMemberships(environmentId);
                  if (catalog && owned && result.value.group.visibility !== "shared")
                    catalog.upsert({
                      id: catalogHostId("group", environmentId, result.value.group.id),
                      kind: "group",
                      title: result.value.group.name,
                      hostRef: { environmentId, entityId: result.value.group.id },
                    });
                  setSetup({ ...initialSetup, requestId: randomUUID() });
                  void navigate({
                    to: "/$environmentId/groups/$groupId",
                    params: { environmentId, groupId: result.value.group.id },
                  });
                } else {
                  const failure = squashAtomCommandFailure(result);
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Could not create this group. Check each member's connection and group membership, then retry.",
                  );
                }
              }}
            >
              {sending ? "Creating…" : "Create group"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Your group setup and unsent messages are saved on this device.
            </p>
          </section>
        ) : (
          <>
            <div
              className="flex shrink-0 flex-wrap gap-2 border-b border-border px-6 py-3"
              aria-label="Group members"
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPrompt((value) => `${value}${value ? " " : ""}@everyone `)}
              >
                @everyone
              </Button>
              {snapshot?.members.map((member) => (
                <Button
                  key={member.id}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPrompt((value) => `${value}${value ? " " : ""}@${member.alias} `)
                  }
                >
                  @{member.alias}
                  <span className="text-muted-foreground">{member.modelSelection.model}</span>
                </Button>
              ))}
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both px-6 py-6"
              aria-live="polite"
              aria-relevant="additions text"
            >
              <div className="mx-auto max-w-3xl space-y-7">
                {snapshot?.messages.map((message) => (
                  <article key={message.id} className="space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      {message.memberId
                        ? (snapshot.members.find((member) => member.id === message.memberId)
                            ?.alias ?? "Member")
                        : message.kind === "user"
                          ? "You"
                          : "Group"}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-sm leading-7">
                      {message.text}
                    </div>
                    {message.truncated ? (
                      <p className="text-xs text-muted-foreground">
                        Open the original mine for the complete reply.
                      </p>
                    ) : null}
                  </article>
                ))}
                {snapshot?.rounds.slice(-1).flatMap((round) =>
                  round.deliveries.map((delivery) => (
                    <div
                      key={delivery.id}
                      className="flex items-center gap-3 text-xs text-muted-foreground"
                    >
                      <span>
                        {round.members.find((member) => member.id === delivery.memberId)?.alias} ·{" "}
                        {delivery.stage} · {delivery.status}
                      </span>
                      {delivery.error ? <span role="status">{delivery.error}</span> : null}
                      {["failed", "unavailable"].includes(delivery.status) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={archived || !retryAllowed}
                          onClick={() =>
                            void retry({
                              environmentId,
                              input: { groupId, roundId: round.id, deliveryId: delivery.id },
                            })
                          }
                        >
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  )),
                )}
                {!snapshot && !query.error ? (
                  <p className="text-sm text-muted-foreground">
                    Connecting to the group coordinator…
                  </p>
                ) : null}
                {snapshot?.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Send a message to start. Mention someone, use @everyone for one reply each, or
                    let members decide whether to participate.
                  </p>
                ) : null}
              </div>
            </div>
            <form
              className="mx-auto w-full max-w-3xl shrink-0 space-y-3 px-6 pb-6"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Textarea
                aria-label="Message the group"
                disabled={archived}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="What should we work on together?"
                rows={3}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">
                  {snapshot
                    ? GROUP_WORKFLOWS.find((option) => option.id === snapshot.group.workflow)?.label
                    : "Team"}{" "}
                  · Shared context · Private history stays in each mine
                </p>
                <Button
                  type="submit"
                  size="icon"
                  disabled={!prompt.trim() || sending || !snapshot || archived || !sendAllowed}
                  aria-label="Send to group"
                >
                  <ArrowUpIcon />
                </Button>
              </div>
            </form>
          </>
        )}
        {error || query.error ? (
          <p role="alert" className="shrink-0 px-6 py-3 text-sm text-destructive">
            {error ?? query.error}
          </p>
        ) : null}
      </main>
    </SidebarInset>
  );
}
