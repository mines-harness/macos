import { useAtomValue } from "@effect/atom-react";
import {
  hiddenCatalogExecutionProjects,
  minesAccountEnvironmentIdsAtom,
  reconcileCatalogHostItems,
} from "@t3tools/client-runtime/catalog";
import { CloudCatalogDevices } from "../cloud/CloudCatalogDevices";
import { CatalogLocalSync } from "../../catalog/CatalogLocalSync";
import { lazy, Suspense, useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronRightIcon,
  FolderInputIcon,
  FolderIcon,
  LayersIcon,
  LibraryIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import {
  catalogHostId,
  canCatalogContain,
  type MinesCatalogEntry,
} from "@t3tools/client-runtime/catalog";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentQuery } from "../../state/query";
import { groupList } from "../../state/groups";
import type { MinesCatalog } from "@t3tools/client-runtime/catalog";
import { useMinesCatalog } from "../../catalog/useMinesCatalog";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  MenuTrigger,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../ui/menu";
import { cn } from "../../lib/utils";
import {
  CatalogDraggableRow,
  CatalogDragProvider,
  CatalogDropArea,
  CatalogDropLine,
} from "./CatalogDragDrop";
import { CatalogContextDialog } from "./CatalogContextDialog";
import { CatalogRowMenu } from "./CatalogRowMenu";
import { canTransferMineAtom } from "../chat/mineTransferAvailability";
import { openMineTransferDialog } from "../chat/mineTransferDialogState";
import { GroupMembershipIndicator } from "../groups/GroupMembershipIndicator";
import { useContactGroups, useContactInvitationCount } from "../contacts/ContactsProvider";
import { isCatalogLibraryEntryVisible } from "./MinesCatalogTree.logic";

const ThreadRelationshipsPanel = lazy(async () => ({
  default: (await import("../chat/ThreadRelationshipsControl")).ThreadRelationshipsPanel,
}));

function CatalogMineTransferItem({ threadRef }: { threadRef: ScopedThreadRef }) {
  const available = useAtomValue(canTransferMineAtom(threadRef.environmentId));
  return available ? (
    <>
      <MenuSeparator />
      <MenuItem onClick={() => openMineTransferDialog(threadRef)}>
        <ArrowRightLeftIcon />
        Transfer mine…
      </MenuItem>
    </>
  ) : null;
}

export function MinesCatalogTree({
  onActivateThread,
  activeThreadKey,
}: {
  onActivateThread: (thread: ScopedThreadRef) => void;
  activeThreadKey: string | null;
}) {
  const { catalog, snapshot, error, accountId } = useMinesCatalog();
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const serverConfigs = useServerConfigs();
  const environments = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const { presentationById } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const ownedEnvironmentIds = useAtomValue(minesAccountEnvironmentIdsAtom);
  const discoveryEnvironmentIds = connected.filter(
    (id) => id === primaryEnvironmentId || ownedEnvironmentIds.has(id),
  );
  const router = useRouter();
  const newThread = useNewThreadHandler();
  const invitations = useContactInvitationCount();
  const sharedGroupIds = new Set(
    useContactGroups().map((group) =>
      catalogHostId("group", group.coordinatorEnvironmentId, group.groupId),
    ),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editor, setEditor] = useState<{ id: string | null; title: string } | null>(null);
  const [contextEntityId, setContextEntityId] = useState<string | null>(null);
  const [agentsFor, setAgentsFor] = useState<{
    threadRef: ScopedThreadRef;
    title: string;
    accountId: string;
  } | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<Readonly<Record<string, number>>>({});
  const threadById = new Map(
    threads.map((thread) => [catalogHostId("thread", thread.environmentId, thread.id), thread]),
  );
  const agentParentIds = new Set(
    threads.flatMap((thread) =>
      thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId
        ? [catalogHostId("thread", thread.environmentId, thread.lineage.parentThreadId)]
        : [],
    ),
  );
  const pinnedIds = new Set(snapshot.pins.map((entry) => entry.entity.id));
  const hiddenProjects = hiddenCatalogExecutionProjects(snapshot);
  const containers = snapshot.entities.filter(
    (entity) =>
      !hiddenProjects.has(entity.id) && (entity.kind === "section" || entity.kind === "project"),
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!catalog) return;
    catalog.transaction(() => {
      for (const environment of environments) {
        if (
          environment.environmentId !== primaryEnvironmentId &&
          !ownedEnvironmentIds.has(environment.environmentId)
        )
          continue;
        catalog.upsert({
          id: catalogHostId("device", environment.environmentId, environment.environmentId),
          kind: "device",
          title: environment.label,
          hostRef: {
            environmentId: environment.environmentId,
            entityId: environment.environmentId,
          },
        });
      }
    });
    reconcileCatalogHostItems(catalog, {
      projects,
      threads,
      environmentIds: new Set([
        ...ownedEnvironmentIds,
        ...(primaryEnvironmentId ? [primaryEnvironmentId] : []),
      ]),
      scratchProjectIds: new Set(
        projects
          .filter((project) =>
            isScratchProject(
              project,
              serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot,
            ),
          )
          .map((project) => catalogHostId("project", project.environmentId, project.id)),
      ),
    });
  }, [
    catalog,
    projects,
    threads,
    environments,
    serverConfigs,
    primaryEnvironmentId,
    ownedEnvironmentIds,
  ]);

  if (error && !catalog)
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {error}
      </p>
    );
  if (!catalog)
    return (
      <p role="status" className="p-3 text-xs text-muted-foreground">
        Opening your library…
      </p>
    );

  const run = (action: () => void) => {
    try {
      action();
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not arrange this item.");
    }
  };
  const toggle = (entry: MinesCatalogEntry, key: string) => {
    const defaultsOpen = entry.entity.kind === "section";
    const currentlyOpen = defaultsOpen ? !collapsed.has(key) : expanded.has(key);
    if (defaultsOpen)
      setCollapsed((current) => {
        const next = new Set(current);
        if (currentlyOpen) next.add(key);
        else next.delete(key);
        return next;
      });
    else
      setExpanded((current) => {
        const next = new Set(current);
        if (currentlyOpen) next.delete(key);
        else next.add(key);
        return next;
      });
  };
  const visible = (entry: MinesCatalogEntry, pinned = false) => {
    if (hiddenProjects.has(entry.entity.id) || sharedGroupIds.has(entry.entity.id)) return false;
    return isCatalogLibraryEntryVisible({
      entity: entry.entity,
      thread: threadById.get(entry.entity.id),
      pinned,
    });
  };
  const renderRows = (
    entries: readonly MinesCatalogEntry[],
    pinned = false,
    path = "library",
    parentId: string | null = null,
  ) => {
    const visibleEntries = entries.filter((entry) => visible(entry, pinned));
    const listKey = pinned ? "pins" : (entries[0]?.parentId ?? "root");
    const count = visibleCounts[listKey] ?? 100;
    return (
      <>
        {visibleEntries.slice(0, count).map((entry, index) => {
          const { entity } = entry;
          const container = entity.kind === "section" || entity.kind === "project";
          const hasAgents =
            entity.kind === "thread" &&
            (entry.children.some((child) => child.entity.kind === "thread") ||
              agentParentIds.has(entity.id));
          const key = `${path}/${encodeURIComponent(entity.id)}`;
          const open = entity.kind === "section" ? !collapsed.has(key) : expanded.has(key);
          const isPinned = pinnedIds.has(entity.id);
          const phase = entity.hostRef
            ? presentationById.get(entity.hostRef.environmentId as EnvironmentId)?.connection.phase
            : "connected";
          const unavailable = phase !== "connected";
          const statusLabel =
            phase === "connecting" || phase === "reconnecting"
              ? "Connecting…"
              : phase === "available"
                ? "Available"
                : phase === "error"
                  ? "Unavailable"
                  : phase === "unsupported"
                    ? "Update needed"
                    : "Offline";
          const thread = threadById.get(entity.id);
          const active = thread && activeThreadKey === `${thread.environmentId}:${thread.id}`;
          const Icon =
            entity.kind === "section"
              ? LayersIcon
              : entity.kind === "project"
                ? FolderIcon
                : entity.kind === "group"
                  ? UsersIcon
                  : entity.kind === "device"
                    ? MonitorIcon
                    : null;
          const textInset =
            entity.kind === "project"
              ? 56
              : entity.kind === "thread" || entity.kind === "group"
                ? 72
                : 40;
          const rowInset = textInset - (container ? 36 : Icon ? 24 : 0);
          const activate = () => {
            if (container) {
              toggle(entry, key);
              return;
            }
            if (entity.kind === "thread" && entity.hostRef)
              onActivateThread(
                scopeThreadRef(
                  entity.hostRef.environmentId as EnvironmentId,
                  entity.hostRef.entityId as ThreadId,
                ),
              );
            if (entity.kind === "group" && entity.hostRef)
              void router.navigate({
                to: "/$environmentId/groups/$groupId",
                params: {
                  environmentId: entity.hostRef.environmentId,
                  groupId: entity.hostRef.entityId,
                },
              });
            if (entity.kind === "device" && entity.hostRef?.entityId.startsWith("cloud:"))
              void router.navigate({
                to: "/$environmentId/cloud/$targetId",
                params: {
                  environmentId: entity.hostRef.environmentId,
                  targetId: entity.hostRef.entityId,
                },
              });
            else if (entity.kind === "device")
              void router.navigate({ to: "/settings/connections" });
          };
          return (
            <li key={key} className="list-none">
              <CatalogDropLine
                id={`${key}:before`}
                target={{ parentId: entry.parentId, beforeId: entity.id, pinned }}
                label={`${pinned ? "Pin" : "Move"} before ${entity.title}`}
              />
              <CatalogRowMenu
                title={entity.title}
                menu={
                  <>
                    <MenuItem
                      onClick={() =>
                        run(() => (isPinned ? catalog.unpin(entity.id) : catalog.pin(entity.id)))
                      }
                    >
                      {isPinned ? <PinOffIcon /> : <PinIcon />}
                      {isPinned ? "Unpin" : "Pin"}
                    </MenuItem>
                    <MenuItem
                      disabled={index === 0}
                      onClick={() =>
                        run(() =>
                          pinned
                            ? catalog.pin(entity.id, visibleEntries[index - 1]!.entity.id)
                            : catalog.move(
                                entity.id,
                                entry.parentId,
                                visibleEntries[index - 1]!.entity.id,
                              ),
                        )
                      }
                    >
                      <ArrowUpIcon />
                      Move up
                    </MenuItem>
                    <MenuItem
                      disabled={index === visibleEntries.length - 1}
                      onClick={() =>
                        run(() =>
                          pinned
                            ? catalog.pin(entity.id, visibleEntries[index + 2]?.entity.id)
                            : catalog.move(
                                entity.id,
                                entry.parentId,
                                visibleEntries[index + 2]?.entity.id,
                              ),
                        )
                      }
                    >
                      <ArrowDownIcon />
                      Move down
                    </MenuItem>
                    <MenuSub>
                      <MenuSubTrigger>
                        <FolderInputIcon />
                        Move to
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuItem onClick={() => run(() => catalog.move(entity.id, null))}>
                          <LibraryIcon />
                          Library
                        </MenuItem>
                        {containers
                          .filter(
                            (target) =>
                              target.id !== entity.id &&
                              canCatalogContain(target.kind, entity.kind),
                          )
                          .map((target) => (
                            <MenuItem
                              key={target.id}
                              onClick={() => run(() => catalog.move(entity.id, target.id))}
                            >
                              {target.kind === "section" ? <LayersIcon /> : <FolderIcon />}
                              {target.title}
                            </MenuItem>
                          ))}
                      </MenuSubPopup>
                    </MenuSub>
                    {container ? (
                      <MenuItem onClick={() => setContextEntityId(entity.id)}>
                        <SettingsIcon />
                        Settings
                      </MenuItem>
                    ) : null}
                    {hasAgents && entity.hostRef ? (
                      <MenuItem
                        onClick={() => {
                          if (!entity.hostRef) return;
                          setAgentsFor({
                            threadRef: scopeThreadRef(
                              entity.hostRef.environmentId as EnvironmentId,
                              entity.hostRef.entityId as ThreadId,
                            ),
                            title: entity.title,
                            accountId,
                          });
                        }}
                      >
                        <BotIcon />
                        Agents…
                      </MenuItem>
                    ) : null}
                    {entity.kind === "thread" && entity.hostRef ? (
                      <CatalogMineTransferItem
                        threadRef={scopeThreadRef(
                          entity.hostRef.environmentId as EnvironmentId,
                          entity.hostRef.entityId as ThreadId,
                        )}
                      />
                    ) : null}
                    {entity.kind === "section" ? (
                      <>
                        <MenuSeparator />
                        <MenuItem onClick={() => setEditor({ id: entity.id, title: entity.title })}>
                          <PencilIcon />
                          Rename section
                        </MenuItem>
                        <MenuItem onClick={() => run(() => catalog.removeContainer(entity.id))}>
                          <Trash2Icon />
                          Remove section, keep contents
                        </MenuItem>
                      </>
                    ) : null}
                  </>
                }
              >
                <CatalogDropArea
                  id={`${key}:row`}
                  target={
                    pinned
                      ? { parentId: null, beforeId: entity.id, pinned: true }
                      : container
                        ? { parentId: entity.id, pinned: false }
                        : { parentId: entry.parentId, beforeId: entity.id, pinned: false }
                  }
                  label={
                    pinned
                      ? `Pin before ${entity.title}`
                      : container
                        ? `Move inside ${entity.title}`
                        : `Move before ${entity.title}`
                  }
                  className={cn(
                    "group group/catalog-row relative flex min-h-9 select-none items-center gap-1 rounded-lg pr-1 text-sidebar-foreground transition-colors motion-reduce:transition-none",
                    active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
                  )}
                  style={{ paddingLeft: rowInset }}
                >
                  <CatalogDraggableRow
                    rowId={key}
                    entityId={entity.id}
                    title={entity.title}
                    onClick={activate}
                    aria-expanded={container ? open : undefined}
                    aria-current={active ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-center rounded-md py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {Icon ? (
                      <span
                        aria-label={entity.kind === "group" ? "Group chat" : undefined}
                        className={cn(
                          "flex shrink-0 items-center",
                          container ? "w-9 gap-1" : "w-6",
                        )}
                      >
                        {container ? (
                          <ChevronRightIcon
                            aria-hidden
                            className={cn(
                              "size-3 shrink-0 transition-transform motion-reduce:transition-none",
                              open && "rotate-90",
                            )}
                          />
                        ) : null}
                        <Icon
                          aria-hidden
                          className={cn(
                            "size-4 shrink-0",
                            entity.kind === "section" && "text-warning",
                            unavailable && "opacity-40",
                          )}
                        />
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{entity.title}</span>
                      {entity.kind === "thread" && entity.importSource?.agentName ? (
                        <span className="block truncate text-3xs text-muted-foreground">
                          {entity.importSource.agentName}
                        </span>
                      ) : null}
                    </span>
                    {entity.kind === "thread" && entity.hostRef ? (
                      <GroupMembershipIndicator
                        environmentId={entity.hostRef.environmentId as EnvironmentId}
                        threadId={entity.hostRef.entityId as ThreadId}
                      />
                    ) : null}
                    {thread?.runtime?.status === "running" ? (
                      <span
                        className="ml-2 size-1.5 rounded-full bg-success"
                        aria-label="Working"
                      />
                    ) : null}
                    {unavailable ? (
                      <span className="ml-2 text-3xs text-muted-foreground">{statusLabel}</span>
                    ) : null}
                  </CatalogDraggableRow>
                  <div className="pointer-events-none flex items-center opacity-0 transition-opacity group-hover/catalog-row:pointer-events-auto group-hover/catalog-row:opacity-100 group-focus-within/catalog-row:pointer-events-auto group-focus-within/catalog-row:opacity-100 group-data-[catalog-menu-open=true]/catalog-menu:pointer-events-auto group-data-[catalog-menu-open=true]/catalog-menu:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100">
                    {entity.kind === "project" && entity.hostRef ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`New mine in ${entity.title}`}
                        onClick={() => {
                          if (!entity.hostRef) return;
                          void newThread(
                            scopeProjectRef(
                              entity.hostRef.environmentId as EnvironmentId,
                              entity.hostRef.entityId as ProjectId,
                            ),
                          );
                        }}
                      >
                        <SquarePenIcon />
                      </Button>
                    ) : null}
                    <MenuTrigger
                      render={<Button size="icon-xs" variant="ghost-muted" />}
                      aria-label={`Arrange ${entity.title}`}
                    >
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                  </div>
                </CatalogDropArea>
              </CatalogRowMenu>
              {container && open ? (
                <ul>
                  {renderRows(entry.children, false, key, entity.id)}
                  {container && entry.children.length === 0 ? (
                    <li>
                      <CatalogDropArea
                        id={`${key}:empty`}
                        target={{ parentId: entity.id, pinned: false }}
                        label={`Move inside ${entity.title}`}
                        className="py-2 text-xs text-muted-foreground"
                        style={{ paddingLeft: entity.kind === "section" ? 56 : 72 }}
                      >
                        {entity.kind === "section"
                          ? "Drop a project or mine here"
                          : "Drop a mine here"}
                      </CatalogDropArea>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
        <li aria-hidden>
          <CatalogDropLine
            id={`${path}:end`}
            target={{ parentId, pinned }}
            label={pinned ? "Pin at the end" : "Move to the end"}
          />
        </li>
        {visibleEntries.length > count ? (
          <li>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setVisibleCounts((current) => ({ ...current, [listKey]: count + 100 }))
              }
            >
              Show more ({visibleEntries.length - count})
            </Button>
          </li>
        ) : null}
      </>
    );
  };
  return (
    <CatalogDragProvider
      key={accountId}
      catalog={catalog}
      accountId={accountId}
      onError={setActionError}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {discoveryEnvironmentIds.map((environmentId) => (
          <CatalogLocalSync
            key={`sync:${environmentId}`}
            environmentId={environmentId}
            catalog={catalog}
            accountId={accountId}
          />
        ))}
        {discoveryEnvironmentIds.map((environmentId) => (
          <CloudCatalogDevices
            key={`cloud:${environmentId}`}
            environmentId={environmentId}
            catalog={catalog}
          />
        ))}
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-xs font-medium text-muted-foreground">Your library</span>
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Shared groups"
              onClick={() => void router.navigate({ to: "/shared-groups" })}
            >
              <UsersIcon />
              {invitations > 0 ? (
                <span className="absolute -top-1 -right-1 min-w-3.5 rounded-full bg-primary px-1 text-3xs leading-3.5 text-primary-foreground">
                  {invitations}
                  <span className="sr-only"> pending invitations</span>
                </span>
              ) : null}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="New section"
              onClick={() => setEditor({ id: null, title: "" })}
            >
              <PlusIcon />
            </Button>
          </div>
        </div>
        {error ? (
          <p role="alert" className="px-2 pb-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="px-2 pb-2 text-xs text-destructive">
            {actionError}
          </p>
        ) : null}
        <CatalogDropArea id="pins" target={{ parentId: null, pinned: true }} label="Pinned">
          <div className="flex items-center gap-2 px-3 py-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            <PinIcon className="size-3" />
            Pinned
          </div>
          <ul aria-label="Pinned items">{renderRows(snapshot.pins, true, "pins")}</ul>
          {snapshot.pins.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground/65">
              Pin a mine, project, section, or device.
            </p>
          ) : null}
        </CatalogDropArea>
        <div className="my-2 border-t border-sidebar-border" />
        <CatalogDropArea
          id="library"
          target={{ parentId: null, pinned: false }}
          label="Library"
          className="min-h-8"
        >
          <ul aria-label="Library">{renderRows(snapshot.roots)}</ul>
        </CatalogDropArea>
        {discoveryEnvironmentIds.map((environmentId) => (
          <CatalogGroups
            key={environmentId}
            environmentId={environmentId}
            catalog={catalog}
            deviceName={
              environments.find((environment) => environment.environmentId === environmentId)
                ?.label ?? "Computer"
            }
          />
        ))}
        <p className="px-3 py-4 text-3xs text-muted-foreground/60">
          Saved on this device · Syncs when peers connect
        </p>
        <Dialog
          open={editor !== null}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{editor?.id ? "Rename section" : "New section"}</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!editor?.title.trim()) return;
                run(() =>
                  editor.id
                    ? catalog.rename(editor.id, editor.title)
                    : catalog.createSection(editor.title),
                );
                setEditor(null);
              }}
            >
              <div className="px-6 pb-6">
                <Input
                  autoFocus
                  aria-label="Section name"
                  placeholder="e.g. Work, Personal, Ideas"
                  value={editor?.title ?? ""}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, title: event.target.value } : null,
                    )
                  }
                />
              </div>
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setEditor(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!editor?.title.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
        {agentsFor?.accountId === accountId ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setAgentsFor(null);
            }}
          >
            <DialogPopup className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Agents for {agentsFor.title}</DialogTitle>
                <DialogDescription>
                  Open an agent conversation or inspect its activity.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Suspense
                  fallback={
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading agents…
                    </p>
                  }
                >
                  <ThreadRelationshipsPanel
                    environmentId={agentsFor.threadRef.environmentId}
                    threadId={agentsFor.threadRef.threadId}
                    onNavigate={() => setAgentsFor(null)}
                  />
                </Suspense>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        ) : null}
        {contextEntityId ? (
          <CatalogContextDialog
            key={`${accountId}:${contextEntityId}`}
            entityId={contextEntityId}
            onClose={() => setContextEntityId(null)}
          />
        ) : null}
      </div>
    </CatalogDragProvider>
  );
}

function CatalogGroups({
  environmentId,
  catalog,
  deviceName,
}: {
  environmentId: EnvironmentId;
  catalog: MinesCatalog;
  deviceName: string;
}) {
  const groups = useEnvironmentQuery(groupList({ environmentId, input: {} }));
  const router = useRouter();
  useEffect(() => {
    const data = groups.data;
    if (!data) return;
    catalog.transaction(() => {
      for (const group of data.groups) {
        if (group.archivedAt !== null || group.visibility === "shared") continue;
        catalog.upsert({
          id: catalogHostId("group", environmentId, group.id),
          kind: "group",
          title: group.name,
          hostRef: { environmentId, entityId: group.id },
        });
      }
    });
  }, [catalog, environmentId, groups.data]);
  const archived =
    groups.data?.groups.filter(
      (group) => group.archivedAt !== null && group.visibility !== "shared",
    ) ?? [];
  return (
    <details
      className="px-3 pt-3 text-xs text-muted-foreground"
      onToggle={(event) => {
        if (event.currentTarget.open) groups.refresh();
      }}
    >
      <summary className="cursor-pointer">Archived groups · {deviceName}</summary>
      {groups.isPending ? (
        <p className="py-2">Loading…</p>
      ) : archived.length === 0 ? (
        <p className="py-2">No archived groups.</p>
      ) : (
        <ul className="py-1">
          {archived.map((group) => (
            <li key={group.id}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void router.navigate({
                    to: "/$environmentId/groups/$groupId",
                    params: { environmentId, groupId: group.id },
                  })
                }
              >
                {group.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {groups.error ? (
        <p role="alert" className="py-2 text-destructive">
          {groups.error}
        </p>
      ) : null}
    </details>
  );
}
