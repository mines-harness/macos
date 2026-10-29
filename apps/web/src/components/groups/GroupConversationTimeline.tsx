import type { LegendListRef } from "@legendapp/list/react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  useEffect,
  lazy,
  Suspense,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useTheme } from "../../hooks/useTheme";
import { useQuietThreadShells, useProjects } from "../../state/entities";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useDebouncedValue } from "../../state/queries";
import { resolveFileAttachmentUrl } from "../ChatView.logic";
import type { ChatFileAttachment } from "../../types";
const AttachmentFilePreview = lazy(() =>
  import("../files/AttachmentFilePreview").then((module) => ({
    default: module.AttachmentFilePreview,
  })),
);
import type { SharedGroupGetInput } from "@t3tools/contracts/sharedGroups";
import { useGroupRunTimeline } from "./useGroupRunTimeline";
import { useGroupMessageHistory } from "./useGroupMessageHistory";
import { GroupRunHtmlRender, GroupRunImage } from "./GroupRunVisual";
import { GroupRunRequests } from "./GroupRunRequests";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import { ThreadFindBar } from "../chat/ThreadFindBar";
import { stepThreadFindIndex } from "../chat/threadFind";
import type { TimelineRow, TimelineRowSharedState } from "../chat/timelineRowContext";
import {
  groupTranscript,
  groupTranscriptSearch,
  type GroupTranscriptSnapshot,
} from "./groupTranscript";

const EMPTY: ReadonlyArray<never> = [];
const ignore = () => {};

export function GroupConversationTimeline({
  environmentId,
  snapshot,
  authorNames,
  listRef: providedListRef,
  footer,
  onCiteAssistantText,
  onOpenThread,
  sharedAddress,
  coordinatorEnvironmentId = environmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: GroupTranscriptSnapshot;
  readonly authorNames?: ReadonlyMap<string, string>;
  readonly listRef?: RefObject<LegendListRef | null>;
  readonly footer?: ReactNode;
  readonly onCiteAssistantText?: ComponentProps<typeof MessagesTimeline>["onCiteAssistantText"];
  readonly onOpenThread?: (ref: ScopedThreadRef) => void;
  readonly sharedAddress?: SharedGroupGetInput;
  readonly coordinatorEnvironmentId?: EnvironmentId;
}) {
  const localListRef = useRef<LegendListRef | null>(null);
  const listRef = providedListRef ?? localListRef;
  const identity = JSON.stringify(["group", environmentId, snapshot.group.id]);
  const history = useGroupMessageHistory({
    environmentId,
    snapshot,
    ...(sharedAddress ? { sharedAddress } : {}),
  });
  const runs = useGroupRunTimeline({
    environmentId,
    snapshot: history.snapshot,
    coordinatorEnvironmentId,
    ...(sharedAddress ? { sharedAddress } : {}),
  });
  const transcript = groupTranscript(
    environmentId,
    runs.snapshot,
    authorNames,
    coordinatorEnvironmentId,
  );
  const { resolvedTheme } = useTheme();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const [atEnd, setAtEnd] = useState(true);
  const [find, setFind] = useState({ open: false, query: "", index: 0, navigation: 0, focus: 0 });
  const [filePreview, setFilePreview] = useState<{
    readonly attachment: ChatFileAttachment;
    readonly environmentId: EnvironmentId;
    readonly threadRef: ScopedThreadRef | null;
  } | null>(null);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchQuery = useDebouncedValue(find.open ? find.query : "", 100);
  const search = groupTranscriptSearch(transcript.entries, find.open ? searchQuery : "");
  const index = Math.min(find.index, Math.max(0, search.total - 1));
  const found = search.navigation.find(
    (entry) => index >= entry.start && index < entry.start + entry.count,
  );
  const closeFind = () => setFind((current) => ({ ...current, open: false }));
  // oxlint-disable-next-line mines/react-effect-budget -- The mounted conversation owns the document Find shortcut and removes it on navigation.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        isCommandPaletteOpen() ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      )
        return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey) || event.altKey)
        return;
      event.preventDefault();
      setFind((current) => ({ ...current, open: true, focus: current.focus + 1 }));
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);
  const download = async (attachment: ChatFileAttachment, sourceEnvironment: EnvironmentId) => {
    const connection = readPreparedConnection(sourceEnvironment);
    if (!connection) {
      toastManager.add({ type: "error", title: "The environment is not connected." });
      return;
    }
    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId: sourceEnvironment,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not download ${attachment.name}`,
        description: cause instanceof Error ? cause.message : "The attachment is unavailable.",
      });
    }
  };
  const rowContext = (row: TimelineRow): Partial<TimelineRowSharedState> => {
    const id = row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : row.id;
    const workEntry =
      row.kind === "work"
        ? row.groupedEntries[0]
        : row.kind === "work-live"
          ? row.entry
          : undefined;
    const runId =
      "runId" in row ? row.runId : row.kind === "proposed-plan" ? row.proposedPlan.runId : null;
    const groupAnchor =
      row.kind === "work-toggle" || row.kind === "thinking"
        ? row.groupId?.replace(/^work-group:/, "")
        : undefined;
    const source =
      transcript.sources.get(id) ??
      (workEntry ? transcript.sources.get(workEntry.id) : undefined) ??
      (groupAnchor ? transcript.sources.get(groupAnchor) : undefined) ??
      (runId ? transcript.sources.get(`run:${runId}`) : undefined);
    if (!source) return {};
    const ref = source.threadRef;
    const shell = ref
      ? shells.find(
          (candidate) =>
            candidate.environmentId === ref.environmentId && candidate.id === ref.threadId,
        )
      : undefined;
    const project = shell
      ? projects.find(
          (candidate) =>
            candidate.environmentId === shell.environmentId && candidate.id === shell.projectId,
        )
      : undefined;
    const workspaceRoot = shell?.worktreePath ?? project?.workspaceRoot;
    const deliveryId = source.deliveryId;
    return {
      messageAuthorLabel: source.authorLabel,
      ...(source.messageTruncated ? { messageTruncated: true } : {}),
      citationMessageId: source.citationMessageId,
      canUseMcpApps:
        readPreparedConnection(source.environmentId) !== null &&
        readEnvironmentScope(source.environmentId, AuthOrchestrationOperateScope),
      activeThreadEnvironmentId: source.environmentId,
      threadRef: source.threadRef,
      markdownCwd: workspaceRoot,
      workspaceRoot,
      ...(source.projectedItem ? { sourceProjectedItem: source.projectedItem } : {}),
      ...(deliveryId
        ? {
            turnItemSource: {
              ...runs.source(deliveryId),
              renderOutputImage: (resource) => (
                <GroupRunImage
                  environmentId={environmentId}
                  groupId={snapshot.group.id}
                  {...(sharedAddress ? { sharedAddress } : {})}
                  deliveryId={deliveryId}
                  itemId={resource.itemId}
                  index={resource.index}
                  onImageExpand={(preview) => openExpandedImagePreview(identity, preview)}
                />
              ),
            },
            onLoadEarlierBody: (row) => runs.loadEarlierBody(deliveryId, row),
            renderHtmlRender: (row) =>
              source.projectedItem ? (
                <GroupRunHtmlRender
                  key={row.htmlRender.attachmentId}
                  environmentId={environmentId}
                  groupId={snapshot.group.id}
                  {...(sharedAddress ? { sharedAddress } : {})}
                  deliveryId={deliveryId}
                  itemId={source.projectedItem.sourceItemId}
                  reference={row.htmlRender}
                />
              ) : null,
            renderViewedImage: (entry) =>
              entry.projectedItem ? (
                <GroupRunImage
                  environmentId={environmentId}
                  groupId={snapshot.group.id}
                  {...(sharedAddress ? { sharedAddress } : {})}
                  deliveryId={deliveryId}
                  itemId={entry.projectedItem.sourceItemId}
                  onImageExpand={(preview) => openExpandedImagePreview(identity, preview)}
                />
              ) : null,
          }
        : {}),
      onOpenThread: (threadId) => onOpenThread?.({ environmentId: source.environmentId, threadId }),
      onFileOpen: (attachment) =>
        setFilePreview({
          attachment,
          environmentId: source.environmentId,
          threadRef: source.threadRef,
        }),
      onFileDownload: (attachment) => void download(attachment, source.environmentId),
    };
  };
  const working = snapshot.rounds.some(
    (round) =>
      round.status === "active" &&
      round.deliveries.some((delivery) => delivery.status === "running" && delivery.runId !== null),
  );
  return (
    <div
      className="relative min-h-0 min-w-0 flex-1"
      aria-label="Group conversation"
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" &&
          find.open &&
          !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          closeFind();
        }
      }}
    >
      <ThreadFindBar
        open={find.open}
        query={find.query}
        matchCount={search.total}
        activeIndex={index}
        status={find.query !== searchQuery ? "loading" : null}
        focusRequestId={find.focus}
        onQueryChange={(query) =>
          setFind((current) => ({
            ...current,
            query,
            index: 0,
            navigation: current.navigation + 1,
          }))
        }
        onNext={() =>
          setFind((current) => ({
            ...current,
            index: stepThreadFindIndex(index, search.total, 1),
            navigation: current.navigation + 1,
          }))
        }
        onPrevious={() =>
          setFind((current) => ({
            ...current,
            index: stepThreadFindIndex(index, search.total, -1),
            navigation: current.navigation + 1,
          }))
        }
        onRetry={ignore}
        onClose={closeFind}
      />
      <MessagesTimeline
        listRef={listRef}
        timelineEntries={transcript.entries}
        resolveRowContext={rowContext}
        isWorking={working}
        activeTurnInProgress={working}
        latestRun={null}
        turnDiffSummaries={EMPTY}
        runs={EMPTY}
        routeThreadKey={identity}
        onOpenThread={ignore}
        onRollbackCheckpoint={ignore}
        supportsConversationRollback={false}
        onRevertToTurnCount={ignore}
        isRevertingCheckpoint={false}
        onImageExpand={(preview) => openExpandedImagePreview(identity, preview)}
        activeThreadEnvironmentId={environmentId}
        markdownCwd={undefined}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={ignore}
        onAnchorSizeChanged={ignore}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled={!find.open && atEnd}
        onIsAtEndChange={setAtEnd}
        onFooterGrow={() => {
          if (atEnd) void listRef.current?.scrollToEnd({ animated: false });
        }}
        findOpen={find.open}
        findExpanded={find.open && find.query.trim().length > 0}
        findQuery={find.open ? searchQuery : ""}
        activeFindMatch={
          found
            ? { entryId: found.entryId, runId: found.runId, occurrence: index - found.start }
            : null
        }
        findNavigationId={find.navigation}
        {...(onCiteAssistantText ? { onCiteAssistantText } : {})}
        footer={
          <>
            {runs.missingCount > 0 ? (
              <div className="chat-content-lane py-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={runs.busyDelivery !== null}
                  onClick={() => void runs.loadNextMissing()}
                >
                  {runs.busyDelivery !== null
                    ? "Loading agent activity…"
                    : "Load more agent activity"}
                </Button>
              </div>
            ) : null}
            {history.error ? (
              <p role="alert" className="chat-content-lane py-2 text-xs text-destructive">
                {history.error}
                <Button size="xs" variant="ghost" onClick={history.retryDeferred}>
                  Retry
                </Button>
              </p>
            ) : null}
            {runs.error ? (
              <p role="alert" className="chat-content-lane py-2 text-xs text-destructive">
                {runs.error}
                <Button size="xs" variant="ghost" onClick={runs.retryDeferred}>
                  Retry
                </Button>
              </p>
            ) : null}
            <div className="chat-content-lane">
              <GroupRunRequests
                environmentId={environmentId}
                snapshot={runs.snapshot}
                {...(sharedAddress ? { sharedAddress } : {})}
              />
            </div>
            {footer}
          </>
        }
        {...(history.hasMore || runs.projections.some((projection) => projection.hasMoreItems)
          ? {
              historyControls: {
                hasMoreHistory: true,
                loading: history.loading || runs.busyDelivery !== null,
                error: history.error ?? runs.error,
                onLoadEarlier: () => {
                  if (history.hasMore) return history.loadEarlier();
                  const projection = runs.projections.find((projection) => projection.hasMoreItems);
                  if (projection) void runs.loadEarlier(projection);
                },
              },
            }
          : {})}
      />
      {transcript.entries.length === 0 &&
      runs.projections.some((projection) => projection.deferredItems.length > 0) ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-4 text-sm text-muted-foreground">
          <p role={runs.error ? "alert" : "status"}>
            {runs.error ?? "Loading conversation activity…"}
          </p>
          {runs.error ? (
            <Button size="sm" variant="outline" onClick={runs.retryDeferred}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {!atEnd && !find.open ? (
        <ScrollToEndButton
          bottom={4}
          summary={null}
          onScrollToEnd={() => {
            setAtEnd(true);
            void listRef.current?.scrollToEnd({ animated: true });
          }}
        />
      ) : null}
      <ExpandedImageDialogHost threadKey={identity} />
      {filePreview ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setFilePreview(null);
          }}
        >
          <DialogPopup className="h-[min(80vh,50rem)] max-w-5xl overflow-hidden">
            <DialogTitle className="sr-only">{filePreview.attachment.name}</DialogTitle>
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading file…</p>}>
              <AttachmentFilePreview
                name={filePreview.attachment.name}
                mimeType={filePreview.attachment.mimeType}
                sizeBytes={filePreview.attachment.sizeBytes}
                asset={{
                  environmentId: filePreview.environmentId,
                  attachmentId: filePreview.attachment.id,
                }}
                {...(filePreview.threadRef ? { threadRef: filePreview.threadRef } : {})}
                onClose={() => setFilePreview(null)}
              />
            </Suspense>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
