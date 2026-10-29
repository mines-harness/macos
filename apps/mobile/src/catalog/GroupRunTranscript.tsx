import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { useAtomValue } from "@effect/atom-react";
import { useDerivedValue } from "react-native-reanimated";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type TurnItemId,
  type RuntimeRequestId,
  type UserInputAttachments,
} from "@t3tools/contracts";
import type {
  GroupId,
  GroupRunProjection,
  GroupRunRespondInput,
  GroupSnapshot,
} from "@t3tools/contracts/groupChat";
import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { useAssetUrlState } from "../state/assets";
import { ConversationTurnItemAccess } from "../state/conversationTurnItemAccess";
import { AppText as Text } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { ConversationMessage } from "../components/ConversationMessage";
import { FilePreviewModal, type FilePreviewSource } from "../components/FilePreviewModal";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { ThreadWorkLog } from "../features/threads/thread-work-log";
import { HtmlRenderWebView, ThreadHtmlRender } from "../features/threads/HtmlRenderWebView";
import { MessageAttachmentList } from "../features/threads/ThreadFeed";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { BodyRangeNotice } from "../features/threads/BodyRangeNotice";
import type { ThreadWorkGroupScrollPosition } from "../features/threads/thread-feed-live-follow";
import {
  buildThreadFeed,
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import {
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "@t3tools/client-runtime/state/thread-requests";
import { PendingApprovalCard } from "../features/threads/PendingApprovalCard";
import { PendingUserInputCard } from "../features/threads/PendingUserInputCard";
import { groupQuestionAttachmentDraftKey } from "../features/threads/QuestionAttachments";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachments,
  flushComposerDrafts,
  clearComposerDraftContent,
} from "../state/use-composer-drafts";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { uuidv4 } from "../lib/uuid";
import { deriveThreadWorkLogSizing } from "../lib/layout";
import {
  groupRunRows,
  groupRunTargets,
  groupRunTargetKey,
  eligibleGroupRunProjections,
  missingGroupRunTargets,
  mergeGroupRunProjections,
  prependGroupRunBody,
} from "./GroupRunTranscript.logic";

const groupRunPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:groups:run-page",
  tag: WS_METHODS.groupsGetRunPage,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const groupRunItem = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:groups:run-item",
  tag: WS_METHODS.groupsGetRunItem,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const groupRunBody = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:groups:run-body",
  tag: WS_METHODS.groupsGetRunBodyRange,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const sharedRunPage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:run-page",
  tag: WS_METHODS.sharedGroupsGetRunPage,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const sharedRunItem = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:run-item",
  tag: WS_METHODS.sharedGroupsGetRunItem,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const sharedRunBody = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:run-body",
  tag: WS_METHODS.sharedGroupsGetRunBodyRange,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const emptyItem = Atom.make(AsyncResult.success({ item: null }));
const groupRespond = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:groups:respond-runtime",
  tag: WS_METHODS.groupsRespondToRuntimeRequest,
});
const sharedRespond = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:shared-groups:respond-runtime",
  tag: WS_METHODS.sharedGroupsRespondToRuntimeRequest,
});
const groupRunAsset = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:groups:run-asset",
  tag: WS_METHODS.groupsGetRunAsset,
  staleTimeMs: 60_000,
  idleTtlMs: 0,
});
const sharedRunAsset = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:shared-groups:run-asset",
  tag: WS_METHODS.sharedGroupsGetRunAsset,
  staleTimeMs: 60_000,
  idleTtlMs: 0,
});

type GroupRunAddress =
  | { readonly groupId: GroupId }
  | { readonly groupKey: string; readonly coordinatorDeviceId: string };

export function useGroupRunProjections({
  environmentId,
  coordinatorEnvironmentId,
  snapshot,
  address,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly snapshot: GroupSnapshot | null | undefined;
  readonly address: GroupRunAddress;
}) {
  const scopeKey = JSON.stringify([
    environmentId,
    "groupId" in address ? [address.groupId] : [address.groupKey, address.coordinatorDeviceId],
  ]);
  const targets = useMemo(
    () => groupRunTargets(snapshot, coordinatorEnvironmentId),
    [snapshot, coordinatorEnvironmentId],
  );
  const accessKey = JSON.stringify(targets.map(groupRunTargetKey));
  const [cache, setCache] = useState<{
    scopeKey: string;
    accessKey: string;
    pages: readonly GroupRunProjection[];
  }>({ scopeKey, accessKey, pages: [] });
  const [pending, setPending] = useState<{ scopeKey: string; token: symbol } | null>(null);
  const [failure, setFailure] = useState<{ scopeKey: string; message: string } | null>(null);
  const latest = useRef<{ scopeKey: string; accessKey: string; targets: typeof targets } | null>(
    null,
  );
  const inFlight = useRef<typeof pending>(null);
  const privatePage = useAtomQueryRunner(groupRunPage, { reportFailure: false, refresh: true });
  const sharedPage = useAtomQueryRunner(sharedRunPage, { reportFailure: false, refresh: true });
  if (cache.scopeKey !== scopeKey || cache.accessKey !== accessKey) {
    setCache({
      scopeKey,
      accessKey,
      pages: cache.scopeKey === scopeKey ? eligibleGroupRunProjections(targets, cache.pages) : [],
    });
  }
  // oxlint-disable-next-line mines/react-effect-budget -- First-page responses must use the currently committed membership before retaining source data.
  useLayoutEffect(() => {
    latest.current = { scopeKey, accessKey, targets };
    return () => {
      latest.current = null;
    };
  }, [scopeKey, accessKey, targets]);
  const cached = eligibleGroupRunProjections(
    targets,
    cache.scopeKey === scopeKey ? cache.pages : [],
  );
  const projections = new Map(cached.map((projection) => [projection.deliveryId, projection]));
  for (const projection of eligibleGroupRunProjections(targets, snapshot?.runProjections ?? [])) {
    const earlier = projections.get(projection.deliveryId);
    projections.set(
      projection.deliveryId,
      earlier ? mergeGroupRunProjections(earlier, projection) : projection,
    );
  }
  const combined = [...projections.values()];
  const missing = missingGroupRunTargets(targets, combined);
  return {
    projections: combined,
    hasMore: missing.length > 0,
    loading: pending?.scopeKey === scopeKey,
    error: failure?.scopeKey === scopeKey ? failure.message : null,
    loadNext: async () => {
      const target = missing[0];
      if (!target || inFlight.current?.scopeKey === scopeKey) return;
      const request = { scopeKey, token: Symbol() };
      inFlight.current = request;
      setPending(request);
      setFailure(null);
      await Promise.resolve()
        .then(async () => {
          const result =
            "groupId" in address
              ? await privatePage({
                  environmentId,
                  input: { ...address, deliveryId: target.deliveryId },
                })
              : await sharedPage({
                  environmentId,
                  input: { ...address, deliveryId: target.deliveryId },
                });
          const current = latest.current;
          if (
            !current ||
            current.scopeKey !== scopeKey ||
            !current.targets.some(
              (candidate) => groupRunTargetKey(candidate) === groupRunTargetKey(target),
            )
          )
            return;
          if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          const projection = result.value;
          if (!projection || !eligibleGroupRunProjections([target], [projection]).length)
            throw new Error("This mine’s activity is no longer available.");
          setCache((previous) => ({
            scopeKey,
            accessKey: current.accessKey,
            pages: [
              ...eligibleGroupRunProjections(
                current.targets,
                previous.scopeKey === scopeKey ? previous.pages : [],
              ).filter((page) => page.deliveryId !== projection.deliveryId),
              projection,
            ],
          }));
        })
        .catch((cause: unknown) => {
          if (latest.current?.scopeKey === scopeKey)
            setFailure({
              scopeKey,
              message:
                cause instanceof Error ? cause.message : "Agent activity could not be loaded.",
            });
        })
        .finally(() => {
          if (inFlight.current === request) {
            inFlight.current = null;
            if (latest.current) setPending((previous) => (previous === request ? null : previous));
          }
        });
    },
  };
}

export function GroupRunLoadMore({
  loader,
}: {
  readonly loader: ReturnType<typeof useGroupRunProjections>;
}) {
  return loader.hasMore || loader.error ? (
    <View className="gap-2 py-2">
      {loader.hasMore ? (
        <Button
          label="Load more agent activity"
          tone="text"
          loading={loader.loading}
          onPress={() => void loader.loadNext()}
        />
      ) : null}
      {loader.error ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {loader.error}
        </Text>
      ) : null}
    </View>
  ) : null;
}

export function GroupRunTranscript({
  environmentId,
  projection,
  address,
}: {
  readonly environmentId: EnvironmentId;
  readonly projection: GroupRunProjection;
  readonly address: GroupRunAddress;
}) {
  const [history, setHistory] = useState<GroupRunProjection | null>(null);
  const [expandedRows, setExpandedRows] = useState<Readonly<Record<string, boolean>>>({});
  const [scrollPositions] = useState(() => new Map<string, ThreadWorkGroupScrollPosition>());
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [respondingRequestId, setRespondingRequestId] = useState<RuntimeRequestId | null>(null);
  const [responseIds] = useState(
    () => new Map<RuntimeRequestId, { fingerprint: string; id: string }>(),
  );
  const { appearance, themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const rowSizing = deriveThreadWorkLogSizing({ baseFontSize: appearance.baseFontSize, fontScale });
  const privatePage = useAtomQueryRunner(groupRunPage, { reportFailure: false, refresh: true });
  const sharedPage = useAtomQueryRunner(sharedRunPage, { reportFailure: false, refresh: true });
  const privateItem = useAtomQueryRunner(groupRunItem, { reportFailure: false, refresh: true });
  const sharedItem = useAtomQueryRunner(sharedRunItem, { reportFailure: false, refresh: true });
  const privateBody = useAtomQueryRunner(groupRunBody, { reportFailure: false, refresh: true });
  const sharedBody = useAtomQueryRunner(sharedRunBody, { reportFailure: false, refresh: true });
  const respondPrivate = useAtomCommand(groupRespond, { reportFailure: false });
  const respondShared = useAtomCommand(sharedRespond, { reportFailure: false });
  const responseAllowed = useAtomValue(
    ("groupId" in address ? groupRespond : sharedRespond).permissionAtom(environmentId),
  );
  const current =
    history?.deliveryId === projection.deliveryId && history.runId === projection.runId
      ? mergeGroupRunProjections(history, projection)
      : projection;
  const feed = buildThreadFeed(groupRunRows(current));
  const pending = derivePendingThreadRequests({
    runtimeRequests: current.runtimeRequests,
    turnItems: current.items,
  });
  const fail = (cause: unknown) =>
    new Error(cause instanceof Error ? cause.message : "The group run could not be loaded.");
  const load = async (key: string, operation: () => Promise<void>) => {
    if (loading) return;
    setLoading(key);
    setError(null);
    await Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => setError(fail(cause).message))
      .finally(() => setLoading(null));
  };
  const ownsRow = (row: OrchestrationV2ProjectedTurnItem) =>
    row.sourceThreadId === projection.threadId && row.item.runId === projection.runId;
  const readAccess = {
    renderOutputImage: (
      resource: Extract<
        import("@t3tools/contracts").AssetResource,
        { readonly _tag: "tool-output-image" }
      >,
    ) => (
      <GroupRunAsset
        environmentId={environmentId}
        projection={projection}
        address={address}
        itemId={resource.itemId}
        kind="image"
        index={resource.index}
        revision={
          current.items.find((item) => item.id === resource.itemId)
            ? turnItemDetailRevision(current.items.find((item) => item.id === resource.itemId)!)
            : undefined
        }
        onPressPreview={setPreview}
      />
    ),
    itemQuery: (row: OrchestrationV2ProjectedTurnItem) => {
      if (!ownsRow(row)) return emptyItem;
      const item = {
        deliveryId: projection.deliveryId,
        itemId: row.sourceItemId,
        revision: turnItemDetailRevision(row.item),
      };
      return "groupId" in address
        ? groupRunItem({ environmentId, input: { ...address, ...item } })
        : sharedRunItem({ environmentId, input: { ...address, ...item } });
    },
    loadEarlierBody: async (row: OrchestrationV2ProjectedTurnItem) => {
      const range = row.item.bodyRange;
      if (!ownsRow(row) || !range || range.startByte === 0) return;
      const body = {
        deliveryId: projection.deliveryId,
        itemId: row.sourceItemId,
        field: range.field,
        before: range.startByte,
        revision: range.revision,
      };
      const result =
        "groupId" in address
          ? await privateBody({ environmentId, input: { ...address, ...body } })
          : await sharedBody({ environmentId, input: { ...address, ...body } });
      if (result._tag !== "Success") throw fail(squashAtomCommandFailure(result));
      const page = result.value;
      if (!page) throw new Error("Earlier content is no longer available. Reload this group.");
      setHistory((previous) => {
        const latest =
          previous?.deliveryId === projection.deliveryId
            ? mergeGroupRunProjections(previous, projection)
            : projection;
        return {
          ...latest,
          items: latest.items.map((item) =>
            item.id === row.sourceItemId ? prependGroupRunBody(item, page) : item,
          ),
        };
      });
    },
  };
  const loadEarlier = () =>
    load("page", async () => {
      const page = {
        deliveryId: projection.deliveryId,
        ...(current.beforeOrdinal === null ? {} : { beforeOrdinal: current.beforeOrdinal }),
      };
      const result =
        "groupId" in address
          ? await privatePage({ environmentId, input: { ...address, ...page } })
          : await sharedPage({ environmentId, input: { ...address, ...page } });
      if (result._tag !== "Success") throw fail(squashAtomCommandFailure(result));
      setHistory((previous) =>
        mergeGroupRunProjections(
          previous?.deliveryId === projection.deliveryId
            ? mergeGroupRunProjections(previous, projection)
            : projection,
          result.value,
          true,
        ),
      );
    });
  const loadDeferred = (reference: GroupRunProjection["deferredItems"][number]) =>
    load(reference.id, async () => {
      const item = {
        deliveryId: projection.deliveryId,
        itemId: reference.id,
        revision: reference.revision,
      };
      const result =
        "groupId" in address
          ? await privateItem({ environmentId, input: { ...address, ...item } })
          : await sharedItem({ environmentId, input: { ...address, ...item } });
      if (result._tag !== "Success") throw fail(squashAtomCommandFailure(result));
      const resolved = result.value.item;
      if (
        !resolved ||
        resolved.threadId !== projection.threadId ||
        resolved.runId !== projection.runId ||
        resolved.type === "user_message"
      )
        throw new Error("This run item is no longer available.");
      setHistory((previous) =>
        mergeGroupRunProjections(
          previous?.deliveryId === projection.deliveryId
            ? mergeGroupRunProjections(previous, projection)
            : projection,
          { ...projection, items: [resolved] },
        ),
      );
    });
  const renderMarkdown = (text: string) => (
    <ConversationMessage environmentId={projection.environmentId} text={text} user={false} />
  );
  const respond = async (input: GroupRuntimeResponse): Promise<boolean> => {
    if (current.canRespond !== true || !responseAllowed || respondingRequestId) return false;
    const fingerprint = JSON.stringify(input);
    const previous = responseIds.get(input.requestId);
    const clientRequestId = previous?.fingerprint === fingerprint ? previous.id : uuidv4();
    responseIds.set(input.requestId, { fingerprint, id: clientRequestId });
    setRespondingRequestId(input.requestId);
    setError(null);
    return Promise.resolve()
      .then(async () => {
        const payload = { ...input, deliveryId: projection.deliveryId, clientRequestId };
        const result =
          "groupId" in address
            ? await respondPrivate({ environmentId, input: { ...address, ...payload } })
            : await respondShared({ environmentId, input: { ...address, ...payload } });
        if (result._tag !== "Success") throw fail(squashAtomCommandFailure(result));
        setHistory((previousProjection) => {
          const latest =
            previousProjection?.deliveryId === projection.deliveryId
              ? mergeGroupRunProjections(previousProjection, projection)
              : projection;
          return {
            ...latest,
            runtimeRequests: latest.runtimeRequests.map((request) =>
              request.id === input.requestId ? { ...request, status: "resolved" } : request,
            ),
          };
        });
        return true;
      })
      .catch((cause: unknown) => {
        setError(fail(cause).message);
        return false;
      })
      .finally(() => {
        setRespondingRequestId(null);
      });
  };
  return (
    <ConversationTurnItemAccess value={readAccess}>
      <View className="gap-3">
        {current.hasMoreItems ? (
          <Button
            label={loading === "page" ? "Loading run history…" : "Load earlier run items"}
            disabled={loading !== null}
            tone="text"
            onPress={() => void loadEarlier()}
          />
        ) : null}
        {feed.map((entry) =>
          entry.type === "message" ? (
            <View key={entry.id} className="gap-1">
              <BodyRangeNotice
                row={entry.message.projectedItem}
                environmentId={environmentId}
                threadId={projection.threadId}
              />
              {renderMarkdown(entry.message.text)}
            </View>
          ) : entry.type === "activity-group" ? (
            <ThreadWorkLog
              key={entry.id}
              threadId={projection.threadId}
              environmentId={projection.environmentId}
              activities={entry.activities}
              continuesWorkLog={entry.continuesWorkLog}
              anchorKey={entry.id}
              copiedRowId={copiedRowId}
              expandedRows={expandedRows}
              rowSizing={rowSizing}
              scrollPositions={scrollPositions}
              iconSubtleColor={colors["--color-foreground-muted"]}
              edgeFadeColor={colors["--color-screen"]}
              themeAppearance={themeAppearance}
              onCopyRow={(rowId, value) => {
                void Clipboard.setStringAsync(value).then(() => setCopiedRowId(rowId));
              }}
              onToggleRow={(rowId, _anchorKey, groupId) =>
                setExpandedRows((rows) => ({
                  ...rows,
                  [rowId]: !rows[rowId],
                  ...(groupId ? { [groupId]: !rows[rowId] } : {}),
                }))
              }
              renderReasoning={renderMarkdown}
              renderImage={(image) => (
                <Text selectable className="text-xs text-foreground-muted">
                  {image.alt ?? image.href}
                </Text>
              )}
              onPressPreview={setPreview}
            />
          ) : entry.type === "html-render" ? (
            <GroupHtmlRunEntry
              key={entry.id}
              environmentId={environmentId}
              projection={current}
              address={address}
              render={entry.render}
            />
          ) : entry.type === "mcp-app" ? (
            <View key={entry.id} className="gap-1">
              <GroupRunAsset
                environmentId={environmentId}
                projection={projection}
                address={address}
                itemId={entry.itemId}
                kind="html"
                revision={entry.revision}
                render={{
                  attachmentId: entry.app.attachmentId,
                  title: entry.app.tool,
                  height: 320,
                }}
              />
              <Text className="text-xs text-foreground-muted">
                App preview · tool actions remain in the owning mine.
              </Text>
            </View>
          ) : null,
        )}
        {current.deferredItems.map((item) => (
          <Button
            key={item.id}
            label={loading === item.id ? "Loading run item…" : "Load additional run item"}
            disabled={loading !== null}
            tone="text"
            onPress={() => void loadDeferred(item)}
          />
        ))}
        {current.canRespond === true && responseAllowed ? (
          <>
            {pending.approvals.map((approval) => (
              <PendingApprovalCard
                key={approval.requestId}
                canOperateThread
                approval={approval}
                respondingApprovalId={respondingRequestId}
                onRespond={(requestId, decision) => respond({ requestId, decision })}
              />
            ))}
            {pending.userInputs.map((input) => (
              <GroupRuntimeUserInput
                key={input.requestId}
                environmentId={environmentId}
                namespace={projection.deliveryId}
                pending={input}
                respondingRequestId={respondingRequestId}
                onRespond={respond}
              />
            ))}
          </>
        ) : (
          current.runtimeRequests
            .filter((request) => request.status === "pending")
            .map((request) => (
              <Text key={request.id} className="text-sm text-foreground-muted">
                {request.kind === "user_input"
                  ? "Waiting for the mine’s owner to answer."
                  : "Waiting for the mine’s owner to approve."}
              </Text>
            ))
        )}
        {error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </ConversationTurnItemAccess>
  );
}

type GroupRuntimeResponse = Omit<
  GroupRunRespondInput,
  "groupId" | "deliveryId" | "clientRequestId"
>;

function GroupRuntimeUserInput({
  environmentId,
  namespace,
  pending,
  respondingRequestId,
  onRespond,
}: {
  readonly environmentId: EnvironmentId;
  readonly namespace: string;
  readonly pending: PendingUserInput;
  readonly respondingRequestId: RuntimeRequestId | null;
  readonly onRespond: (input: GroupRuntimeResponse) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>(() =>
    seedUserInputDraftAnswers(pending.questions, {}),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allDrafts = useAtomValue(composerDraftsAtom);
  const { height } = useWindowDimensions();
  const maxHeight = useDerivedValue(() => Math.max(260, height * 0.65), [height]);
  const answers = buildPendingUserInputAnswers(
    pending.questions,
    Object.fromEntries(
      pending.questions.map((question) => {
        const key = groupQuestionAttachmentDraftKey(
          environmentId,
          namespace,
          pending.requestId,
          question.id,
        );
        return [
          question.id,
          { ...drafts[question.id], attachmentCount: allDrafts[key]?.attachments.length ?? 0 },
        ];
      }),
    ),
  );
  const submit = async () => {
    if (!answers) return;
    setError(null);
    await Promise.resolve()
      .then(async () => {
        const attachmentsByQuestionId: Record<string, UserInputAttachments[string]> = {};
        for (const question of pending.questions) {
          const key = groupQuestionAttachmentDraftKey(
            environmentId,
            namespace,
            pending.requestId,
            question.id,
          );
          const draft = getComposerDraftSnapshot(key);
          if (!draft.attachments.length) continue;
          const prepared = await prepareTurnAttachments({
            environmentId,
            attachments: draft.attachments,
            supportsImageUploads: true,
            persistUploadedReferences: async (attachments) => {
              replaceComposerDraftAttachments(key, attachments);
              await flushComposerDrafts();
              return "persisted";
            },
          });
          if (prepared.status !== "ready")
            throw new Error("Attachments changed while preparing your answer.");
          attachmentsByQuestionId[question.id] = prepared.attachments.map((attachment) => {
            if (attachment.id === undefined)
              throw new Error("Reconnect to finish uploading your answer attachments.");
            return { ...attachment, id: attachment.id };
          });
        }
        if (
          await onRespond({
            requestId: pending.requestId,
            answers,
            ...(Object.keys(attachmentsByQuestionId).length ? { attachmentsByQuestionId } : {}),
          })
        ) {
          for (const question of pending.questions)
            clearComposerDraftContent(
              groupQuestionAttachmentDraftKey(
                environmentId,
                namespace,
                pending.requestId,
                question.id,
              ),
            );
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Your answer could not be sent.");
      });
  };
  return (
    <View className="gap-2">
      <PendingUserInputCard
        inline
        questionAttachmentTarget={{ environmentId, groupNamespace: namespace }}
        canOperateThread
        pendingUserInput={pending}
        maxHeight={maxHeight}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        drafts={drafts}
        answers={answers}
        respondingUserInputId={respondingRequestId}
        onSelectOption={(_requestId, question, value) =>
          setDrafts((current) => ({
            ...current,
            [question.id]: togglePendingUserInputOptionSelection(
              question,
              current[question.id],
              value,
            ),
          }))
        }
        onChangeCustomAnswer={(_requestId, questionId, value) => {
          const question = pending.questions.find((candidate) => candidate.id === questionId);
          if (question)
            setDrafts((current) => ({
              ...current,
              [questionId]: setPendingUserInputCustomAnswer(question, current[questionId], value),
            }));
        }}
        onSubmit={submit}
        onDismiss={() => onRespond({ requestId: pending.requestId, dismiss: true })}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function GroupHtmlRunEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly projection: GroupRunProjection;
  readonly address: GroupRunAddress;
  readonly render: HtmlRenderReference;
}) {
  const source = props.projection.items.find(
    (item) =>
      item.type === "dynamic_tool" &&
      htmlRenderFromToolItem(item)?.attachmentId === props.render.attachmentId,
  );
  return source ? (
    <GroupRunAsset
      {...props}
      itemId={source.id}
      kind="html"
      revision={turnItemDetailRevision(source)}
    />
  ) : null;
}

function GroupRunAsset({
  environmentId,
  projection,
  address,
  itemId,
  kind,
  index,
  revision,
  render,
  onPressPreview,
}: {
  readonly environmentId: EnvironmentId;
  readonly projection: GroupRunProjection;
  readonly address: GroupRunAddress;
  readonly itemId: TurnItemId;
  readonly kind: "html" | "image";
  readonly index?: number;
  readonly revision?: string;
  readonly render?: HtmlRenderReference;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
}) {
  const query = {
    deliveryId: projection.deliveryId,
    itemId,
    kind,
    ...(index === undefined ? {} : { index }),
    ...(revision === undefined ? {} : { revision }),
  };
  const asset = useEnvironmentQuery(
    "groupId" in address
      ? groupRunAsset({ environmentId, input: { ...address, ...query } })
      : sharedRunAsset({ environmentId, input: { ...address, ...query } }),
  );
  const [expanded, setExpanded] = useState(false);
  const [localPreview, setLocalPreview] = useState<FilePreviewSource | null>(null);
  const { width } = useWindowDimensions();
  const { themeVariables } = useAppearancePreferences();
  const url = useAssetUrlState(
    environmentId,
    expanded && asset.data
      ? {
          _tag: "attachment",
          attachmentId: asset.data.id,
          mimeType: "text/html",
          disposition: "inline",
        }
      : null,
  );
  if (!asset.data)
    return (
      <View className="py-2">
        <Text className="text-xs text-foreground-muted">
          {asset.error
            ? `Could not load ${kind === "html" ? "visualization" : "image"}: ${asset.error}`
            : "Loading shared media…"}
        </Text>
        {asset.error ? <Button label="Retry" tone="text" onPress={asset.refresh} /> : null}
      </View>
    );
  if (kind === "image")
    return (
      <>
        <MessageAttachmentList
          environmentId={environmentId}
          attachments={[asset.data]}
          onPressPreview={onPressPreview ?? setLocalPreview}
        />
        <FilePreviewModal source={localPreview} onRequestClose={() => setLocalPreview(null)} />
      </>
    );
  if (!render) return null;
  return (
    <>
      <ThreadHtmlRender
        environmentId={environmentId}
        threadId={projection.threadId}
        render={{ ...render, attachmentId: asset.data.id }}
        frameWidth={Math.max(160, width - 64)}
        iconColor={themeVariables["--color-foreground-muted"]}
        onOpen={() => setExpanded(true)}
      />
      <Modal
        visible={expanded}
        onRequestClose={() => setExpanded(false)}
        presentationStyle="pageSheet"
        animationType="slide"
      >
        <SafeAreaView className="flex-1 bg-screen">
          <Button label="Close" tone="text" onPress={() => setExpanded(false)} />
          {url._tag === "Success" ? (
            <HtmlRenderWebView uri={url.url} title={render.title} nested={false} />
          ) : (
            <Text className="p-4 text-foreground-muted">Loading visualization…</Text>
          )}
        </SafeAreaView>
      </Modal>
    </>
  );
}
