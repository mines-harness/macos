import {
  GroupChatError,
  GroupId,
  GroupSnapshot,
  GroupAttachmentChunk,
  type ChatAttachment,
  type GroupMember,
  UserInputAttachments,
  GroupRunProjection,
  GroupMessageChunk,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2BodyRangeResult,
  IsoDateTime,
  CONVERSATION_ACTIVITY_TTL_MS,
  type ConversationActivityKind,
  type GroupMemberInput,
  type GroupPeerRequest,
  type ThreadId,
} from "@t3tools/contracts";
import type { SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import {
  type SharedGroupGetInput,
  type SharedGroupSendInput,
  type SharedGroupAddChatsInput,
  type SharedGroupRemoveChatsInput,
  type SharedGroupPeerCall,
  type SharedGroupPeerResult,
  type SharedGroupView,
  SharedGroupActivityView,
  type SharedGroupActivityInput,
  type SharedGroupRunAssetInput,
  type SharedGroupRunRespondInput,
  type SharedGroupHistoryInput,
  type SharedGroupMessageChunkInput,
  type SharedGroupRunPageInput,
  type SharedGroupRunItemInput,
  type SharedGroupRunBodyInput,
} from "@t3tools/contracts/sharedGroups";
import { sharedGroupContentRevision } from "@t3tools/shared/minesSharedGroupAccess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as PubSub from "effect/PubSub";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as GroupAttachments from "./GroupAttachments.ts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import * as GroupChatService from "./GroupChatService.ts";
import * as GroupPeerStore from "./GroupPeerStore.ts";
import * as SharedGroupTransport from "./SharedGroupTransport.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import {
  sharedGroupEnvironmentId,
  sharedGroupMemberInputs,
  sharedGroupSnapshot,
  sharedGroupRevision,
} from "./sharedGroupPolicy.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(GroupSnapshot);
const decodeUserInputAttachments = Schema.decodeUnknownEffect(UserInputAttachments);
const decodeAttachmentChunk = Schema.decodeUnknownEffect(GroupAttachmentChunk);
const decodeActivity = Schema.decodeUnknownEffect(SharedGroupActivityView);
const decodeMessageChunk = Schema.decodeUnknownEffect(GroupMessageChunk);
const denied = () =>
  new GroupChatError({
    code: "not-group-turn",
    message: "This device cannot access the requested shared group or chat.",
  });
const unavailable = () =>
  new GroupChatError({
    code: "dispatch",
    message: "This shared group is offline. Your note was not queued or sent.",
  });
export class SharedGroupService extends Context.Service<
  SharedGroupService,
  {
    readonly respondToRuntimeRequest: (
      input: SharedGroupRunRespondInput,
    ) => Effect.Effect<void, GroupChatError>;
    readonly getRunAsset: (
      input: SharedGroupRunAssetInput,
    ) => Effect.Effect<ChatAttachment, GroupChatError>;
    readonly getHistory: (
      input: SharedGroupHistoryInput,
    ) => Effect.Effect<SharedGroupView, GroupChatError>;
    readonly getMessageChunk: (
      input: SharedGroupMessageChunkInput,
    ) => Effect.Effect<GroupMessageChunk, GroupChatError>;
    readonly getRunPage: (
      input: SharedGroupRunPageInput,
    ) => Effect.Effect<GroupRunProjection, GroupChatError>;
    readonly getRunItem: (
      input: SharedGroupRunItemInput,
    ) => Effect.Effect<OrchestrationV2GetTurnItemResult, GroupChatError>;
    readonly getRunBodyRange: (
      input: SharedGroupRunBodyInput,
    ) => Effect.Effect<OrchestrationV2BodyRangeResult | null, GroupChatError>;
    readonly publishActivity: (
      input: SharedGroupActivityInput,
    ) => Effect.Effect<void, GroupChatError>;
    readonly activityStream: (
      input: SharedGroupGetInput,
    ) => Stream.Stream<SharedGroupActivityView, GroupChatError>;
    readonly get: (input: SharedGroupGetInput) => Effect.Effect<SharedGroupView, GroupChatError>;
    readonly subscribe: (
      input: SharedGroupGetInput,
    ) => Stream.Stream<SharedGroupView, GroupChatError>;
    readonly send: (input: SharedGroupSendInput) => Effect.Effect<SharedGroupView, GroupChatError>;
    readonly addChats: (
      input: SharedGroupAddChatsInput,
    ) => Effect.Effect<SharedGroupView, GroupChatError>;
    readonly removeChats: (
      input: SharedGroupRemoveChatsInput,
    ) => Effect.Effect<SharedGroupView, GroupChatError>;
    readonly leave: (input: SharedGroupGetInput) => Effect.Effect<void, GroupChatError>;
  }
>()("mines/groupChat/SharedGroupService") {}

const make = Effect.gen(function* () {
  const groups = yield* GroupChatService.GroupChatService;
  const attachments = yield* GroupAttachments.GroupAttachments;
  const transport = yield* SharedGroupTransport.SharedGroupTransport;
  const peers = yield* GroupPeerStore.GroupPeerStore;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const ownDevice = trust.identity.pipe(
    Effect.map((identity) => identity.device.deviceId),
    Effect.mapError(denied),
  );
  const scope = yield* Scope.Scope;
  const activityChanges = yield* PubSub.sliding<string>(64);
  const activity = new Map<string, Map<string, SharedGroupActivityView["participants"][number]>>();
  const readActivity = Effect.fn("SharedGroupService.readActivity")(function* (groupKey: string) {
    const at = yield* Clock.currentTimeMillis;
    const participants = new Map<string, SharedGroupActivityView["participants"][number]>();
    for (const entry of activity.get(groupKey)?.values() ?? []) {
      if (Date.parse(entry.expiresAt) <= at) continue;
      const previous = participants.get(entry.friendId);
      if (!previous || entry.kind === "voice" || previous.kind !== "voice")
        participants.set(entry.friendId, entry);
    }
    return { participants: [...participants.values()] };
  });
  const clearActivity = Effect.fn("SharedGroupService.clearActivity")(function* (
    groupKey: string,
    deviceId: string,
  ) {
    const entries = activity.get(groupKey);
    if (!entries?.delete(deviceId)) return;
    if (entries.size === 0) activity.delete(groupKey);
    yield* PubSub.publish(activityChanges, groupKey);
  });
  const writeActivity = Effect.fn("SharedGroupService.writeActivity")(function* (
    groupKey: string,
    deviceId: string,
    friendId: SharedGroupActivityView["participants"][number]["friendId"],
    kind: ConversationActivityKind,
  ) {
    if (kind === "idle") {
      yield* clearActivity(groupKey, deviceId);
      return;
    }
    const entries = activity.get(groupKey) ?? new Map();
    if (!entries.has(deviceId) && entries.size >= 64) return yield* denied();
    const expiresAt = IsoDateTime.make(
      DateTime.formatIso(DateTime.addDuration(yield* DateTime.now, CONVERSATION_ACTIVITY_TTL_MS)),
    );
    entries.set(deviceId, { friendId, kind, expiresAt });
    activity.set(groupKey, entries);
    yield* PubSub.publish(activityChanges, groupKey);
    yield* Effect.sleep(CONVERSATION_ACTIVITY_TTL_MS).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          activity.get(groupKey)?.get(deviceId)?.expiresAt === expiresAt
            ? clearActivity(groupKey, deviceId)
            : Effect.void,
        ),
      ),
      Effect.forkIn(scope),
    );
  });
  const watchActivity = Effect.fn("SharedGroupService.watchActivity")(function* (
    groupKey: string,
    after: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* PubSub.subscribe(activityChanges);
        let value = yield* readActivity(groupKey);
        while (sharedGroupContentRevision(value) === after) {
          yield* PubSub.take(changes);
          value = yield* readActivity(groupKey);
        }
        return value;
      }),
    );
  });
  const cleanup = Effect.fn("SharedGroupService.cleanup")(function* (
    input: SharedGroupGetInput,
    clearSelection: boolean,
    threadIds?: ReadonlyArray<ThreadId>,
  ) {
    const selected = threadIds ?? (yield* transport.selected(input.groupKey));
    const route = sharedGroupEnvironmentId(input.groupKey, input.coordinatorDeviceId);
    for (const threadId of selected) {
      const member = yield* peers.membership(threadId);
      if (member?.coordinatorEnvironmentId === route) yield* peers.release(member);
    }
    if (clearSelection) yield* transport.select(input.groupKey, selected, false);
  });
  const access = Effect.fn("SharedGroupService.access")(function* (input: SharedGroupGetInput) {
    const grant = yield* transport
      .authorize(input.groupKey, input.coordinatorDeviceId)
      .pipe(
        Effect.tapError((error) =>
          error.code === "not-group-turn" ? cleanup(input, true) : Effect.void,
        ),
      );
    if (grant.coordinatorDevice.deviceId !== input.coordinatorDeviceId) return yield* denied();
    if (
      grant.from.deviceId === input.coordinatorDeviceId &&
      grant.coordinatorEnvironmentId !== environmentId
    )
      return yield* denied();
    return grant;
  });
  const ownsMember = Effect.fn("SharedGroupService.ownsMember")(function* (
    grant: SharedGroupDeviceGrant,
    member: GroupMember,
    actor: string,
    fresh: boolean,
  ) {
    if (member.environmentId === null)
      return (
        actor ===
        (grant.from.deviceId === grant.coordinatorDevice.deviceId
          ? grant.fromFriendId
          : grant.toFriendId)
      );
    return (yield* transport.routeFriendId(grant.groupKey, member.environmentId, fresh)) === actor;
  });
  const authorizeSnapshot = Effect.fn("SharedGroupService.authorizeSnapshot")(function* (
    grant: SharedGroupDeviceGrant,
    initial: GroupSnapshot,
    actor = grant.fromFriendId,
  ) {
    const groupId = GroupId.make(grant.groupId);
    let result = initial;
    if (result.group.visibility !== "shared" || grant.coordinatorEnvironmentId !== environmentId)
      return yield* denied();
    const routes = new Set(
      result.members.flatMap((member) =>
        member.environmentId === null ? [] : [member.environmentId],
      ),
    );
    const revoked = new Set(yield* transport.revokedRoutes(grant.groupKey, routes));
    const removed = result.members.filter(
      (member) => member.environmentId !== null && revoked.has(member.environmentId),
    );
    if (removed.length > 0)
      result = yield* groups.removeMembers({
        groupId,
        memberIds: removed.map((member) => member.id),
        cancelActive: true,
      });
    const runProjections = yield* Effect.forEach(
      result.runProjections ?? [],
      (projection) =>
        Effect.gen(function* () {
          const member = result.members.find((candidate) => candidate.id === projection.memberId);
          return {
            ...projection,
            canRespond: member ? yield* ownsMember(grant, member, actor, false) : false,
          };
        }),
      { concurrency: 4 },
    );
    return sharedGroupSnapshot({ ...result, runProjections });
  });
  const snapshot = Effect.fn("SharedGroupService.snapshot")(function* (
    grant: SharedGroupDeviceGrant,
    actor = grant.fromFriendId,
  ) {
    return yield* authorizeSnapshot(
      grant,
      yield* groups.get({ groupId: GroupId.make(grant.groupId) }),
      actor,
    );
  });
  const watch = Effect.fn("SharedGroupService.watch")(function* (
    grant: SharedGroupDeviceGrant,
    after: string,
    actor = grant.fromFriendId,
  ) {
    const next = yield* groups.subscribe({ groupId: GroupId.make(grant.groupId) }).pipe(
      Stream.mapEffect((value) => authorizeSnapshot(grant, value, actor)),
      Stream.filter((value) => sharedGroupRevision(value) !== after),
      Stream.runHead,
    );
    if (Option.isNone(next)) return yield* unavailable();
    return next.value;
  });
  const peer = Effect.fn("SharedGroupService.peer")(function* (
    grant: SharedGroupDeviceGrant,
    call: SharedGroupPeerCall,
  ): Effect.fn.Return<SharedGroupPeerResult, GroupChatError> {
    const deviceId = yield* ownDevice;
    const coordinator = grant.coordinatorDevice.deviceId;
    const groupId = GroupId.make(grant.groupId);
    if (
      call.type === "activity" ||
      call.type === "activity-get" ||
      call.type === "activity-watch"
    ) {
      if (deviceId !== coordinator) return yield* denied();
      if (call.type === "activity")
        yield* writeActivity(grant.groupKey, grant.to.deviceId, grant.toFriendId, call.kind);
      return call.type === "activity-watch"
        ? yield* watchActivity(grant.groupKey, call.after)
        : yield* readActivity(grant.groupKey);
    }
    if (call.type === "capabilities") {
      if (deviceId !== coordinator) return yield* denied();
      return { type: "capabilities", supportsRichMessages: true };
    }
    if (call.type === "runtime-response") {
      if (deviceId !== coordinator) return yield* denied();
      const member = yield* groups.getDeliveryMember({ groupId, deliveryId: call.deliveryId });
      if (!(yield* ownsMember(grant, member, grant.toFriendId, true))) return yield* denied();
      const byQuestion: Record<string, ReadonlyArray<ChatAttachment>> = {};
      for (const [key, files] of Object.entries(call.attachmentsByQuestionId ?? {}))
        byQuestion[key] = (yield* attachments.restore(
          `shared-upload:${grant.groupKey}:${grant.to.deviceId}`,
          { attachments: files },
        )).attachments;
      const attachmentsByQuestionId = yield* decodeUserInputAttachments(byQuestion).pipe(
        Effect.mapError(denied),
      );
      yield* groups.respondToRuntimeRequest({ ...call, groupId, attachmentsByQuestionId });
      return { type: "ok" };
    }
    if (call.type === "run-asset") {
      if (deviceId !== coordinator) return yield* denied();
      return { type: "run-asset", chunk: yield* groups.readRunAsset({ ...call, groupId }) };
    }
    if (call.type === "history" || call.type === "message-chunk") {
      if (deviceId !== coordinator) return yield* denied();
      return call.type === "history"
        ? yield* groups.getHistory({
            groupId,
            ...(call.beforeMessageId ? { beforeMessageId: call.beforeMessageId } : {}),
          })
        : yield* groups.getMessageChunk({
            groupId,
            messageId: call.messageId,
            offset: call.offset,
          });
    }
    if (call.type === "run-page" || call.type === "run-item" || call.type === "run-body-range") {
      if (deviceId !== coordinator) return yield* denied();
      if (call.type === "run-page") {
        const member = yield* groups.getDeliveryMember({ groupId, deliveryId: call.deliveryId });
        const projection = yield* groups.getRunPage({ ...call, groupId });
        return {
          type: "run-page",
          projection: {
            ...projection,
            canRespond: yield* ownsMember(grant, member, grant.toFriendId, true),
          },
        };
      }
      return call.type === "run-item"
        ? { type: "run-item", result: yield* groups.getRunItem({ ...call, groupId }) }
        : { type: "run-body-range", result: yield* groups.getRunBodyRange({ ...call, groupId }) };
    }
    if (call.type === "attachment-put" || call.type === "attachment-read") {
      if (deviceId !== coordinator) return yield* denied();
      return call.type === "attachment-put"
        ? {
            type: "attachment-stored",
            attachment: yield* attachments.receive(
              `shared-upload:${grant.groupKey}:${grant.to.deviceId}`,
              call.chunk,
            ),
          }
        : yield* groups.readAttachment({
            groupId,
            attachmentId: call.attachmentId,
            offset: call.offset,
          });
    }
    if (deviceId === coordinator) {
      if (call.type === "watch") return yield* watch(grant, call.after, grant.toFriendId);
      const current = yield* snapshot(grant, grant.toFriendId);
      const route = sharedGroupEnvironmentId(grant.groupKey, grant.to.deviceId);
      if (route === environmentId) return yield* denied();
      switch (call.type) {
        case "get":
          return current;
        case "send": {
          const payload =
            call.contextFile || call.attachments?.length
              ? yield* attachments.restore(
                  `shared-upload:${grant.groupKey}:${grant.to.deviceId}`,
                  call,
                )
              : call;
          return sharedGroupSnapshot(
            yield* groups.sendShared(
              {
                groupId,
                message: call.message,
                ...(call.interactionMode ? { interactionMode: call.interactionMode } : {}),
                ...(payload.attachments ? { attachments: payload.attachments } : {}),
                ...(payload.context ? { context: payload.context } : {}),
                clientRequestId: sharedGroupContentRevision([
                  grant.to.deviceId,
                  call.clientRequestId,
                ]),
                requestAiResponse: call.requestAiResponse ?? false,
              },
              grant.toFriendId,
            ),
          );
        }
        case "add-chats": {
          const members = yield* Effect.try({
            try: () => sharedGroupMemberInputs(call.members, route),
            catch: denied,
          });
          const bound = yield* transport.bindRoute(grant.groupKey, grant.to.deviceId);
          if (bound !== route) return yield* denied();
          return sharedGroupSnapshot(
            yield* groups.addSharedMembers({
              groupId,
              members,
              clientRequestId: sharedGroupContentRevision([
                grant.to.deviceId,
                call.clientRequestId,
              ]),
            }),
          );
        }
        case "remove-chats":
          return sharedGroupSnapshot(
            yield* groups.removeMembers({
              groupId,
              memberIds: current.members
                .filter(
                  (member) =>
                    member.environmentId === route && call.threadIds.includes(member.threadId),
                )
                .map((member) => member.id),
              cancelActive: true,
            }),
          );
        case "native": {
          const request = call.request;
          if (
            (request.type !== "ask" && request.type !== "changed") ||
            request.groupId !== groupId ||
            !current.members.some(
              (member) =>
                member.environmentId === route &&
                member.threadId === request.threadId &&
                member.id === request.memberId,
            )
          )
            return yield* denied();
          return yield* groups.peer(route, request);
        }
      }
    }
    if (grant.to.deviceId !== coordinator || call.type !== "native") return yield* denied();
    const request = call.request;
    if (
      request.type === "ask" ||
      request.type === "changed" ||
      ("groupId" in request && request.groupId !== groupId)
    )
      return yield* denied();
    const selected = yield* transport.selected(grant.groupKey);
    if (!selected.includes(request.threadId)) return yield* denied();
    const route = sharedGroupEnvironmentId(grant.groupKey, coordinator);
    if (route === environmentId) return yield* denied();
    const safeRequest: GroupPeerRequest =
      request.type === "dispatch"
        ? (({ catalogContextRevision: _revision, ...rest }) => rest)(request)
        : request;
    if (request.type !== "describe" && request.type !== "reserve" && request.type !== "release") {
      const membership = yield* peers.membership(request.threadId);
      if (!membership)
        yield* groups.peer(route, {
          type: "reserve",
          groupId,
          memberId: request.memberId,
          threadId: request.threadId,
        });
    }
    return yield* groups.peer(route, safeRequest);
  });
  const unregister = transport.register(
    peer,
    Effect.fn("SharedGroupService.disconnected")(function* (grant, revoked) {
      if (grant.from.deviceId === grant.coordinatorDevice.deviceId) {
        yield* clearActivity(grant.groupKey, grant.to.deviceId);
        if (!revoked) return;
        const current = yield* groups.get({ groupId: GroupId.make(grant.groupId) });
        const route = sharedGroupEnvironmentId(grant.groupKey, grant.to.deviceId);
        const memberIds = current.members
          .filter((member) => member.environmentId === route)
          .map((member) => member.id);
        if (memberIds.length > 0)
          yield* groups.removeMembers({ groupId: current.group.id, memberIds, cancelActive: true });
        return;
      }
      yield* cleanup(
        { groupKey: grant.groupKey, coordinatorDeviceId: grant.coordinatorDevice.deviceId },
        revoked,
      );
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unregister));
  const call = Effect.fn("SharedGroupService.call")(function* (
    input: SharedGroupGetInput,
    request: SharedGroupPeerCall,
  ) {
    const grant = yield* access(input);
    const deviceId = yield* ownDevice;
    const result =
      deviceId === input.coordinatorDeviceId
        ? request.type === "get"
          ? yield* snapshot(grant)
          : request.type === "watch"
            ? yield* watch(grant, request.after)
            : yield* peer(grant, request)
        : yield* transport.request(input.groupKey, input.coordinatorDeviceId, request);
    yield* access(input);
    return yield* decodeSnapshot(result).pipe(Effect.mapError(denied));
  });
  const view = Effect.fn("SharedGroupService.view")(function* (
    input: SharedGroupGetInput,
    value: GroupSnapshot,
  ): Effect.fn.Return<SharedGroupView, GroupChatError> {
    let localized = value;
    if ((yield* ownDevice) !== input.coordinatorDeviceId) {
      const scope = `shared-cache:${input.groupKey}:${input.coordinatorDeviceId}`;
      const messages = yield* Effect.forEach(
        value.messages,
        (message) =>
          Effect.gen(function* () {
            if (!message.attachments?.length) return message;
            const local = [];
            for (const attachment of message.attachments) {
              let copy = yield* attachments.cached(scope, attachment);
              if (!copy) {
                let offset = 0;
                do {
                  const result = yield* transport.request(
                    input.groupKey,
                    input.coordinatorDeviceId,
                    { type: "attachment-read", attachmentId: attachment.id, offset },
                  );
                  const chunk = yield* decodeAttachmentChunk(result).pipe(Effect.mapError(denied));
                  if (chunk.attachment.id !== attachment.id || chunk.offset !== offset)
                    return yield* denied();
                  copy = yield* attachments.receive(scope, chunk);
                  offset += Buffer.from(chunk.data, "base64").length;
                  if (chunk.complete) break;
                } while (offset < attachment.sizeBytes);
              }
              if (!copy) return yield* unavailable();
              local.push(copy);
            }
            const context = message.context
              ? remapComposerContextAttachments(message.context, message.attachments, local)
              : undefined;
            return { ...message, attachments: local, ...(context ? { context } : {}) };
          }),
        { concurrency: 2 },
      );
      localized = { ...value, messages };
    }
    return {
      status: "online",
      snapshot: sharedGroupSnapshot(localized),
      selectedThreadIds: yield* transport.selected(input.groupKey),
    };
  });
  const get = Effect.fn("SharedGroupService.get")(function* (input: SharedGroupGetInput) {
    return yield* call(input, { type: "get" }).pipe(
      Effect.flatMap((value) => view(input, value)),
      Effect.catchIf(
        (error) => error.code === "dispatch",
        () =>
          Effect.succeed({
            status: "offline" as const,
            snapshot: null,
            selectedThreadIds: [] as ReadonlyArray<ThreadId>,
          }),
      ),
    );
  });
  const normalized = Effect.fn("SharedGroupService.ownMembers")(function* (
    members: ReadonlyArray<typeof GroupMemberInput.Type>,
  ) {
    if (
      members.some(
        (member) => member.environmentId !== undefined && member.environmentId !== environmentId,
      )
    )
      return yield* denied();
    return members.map(({ environmentId: _environment, ...member }) => member);
  });
  const addChats = Effect.fn("SharedGroupService.addChats")(function* (
    input: SharedGroupAddChatsInput,
  ) {
    const grant = yield* access(input);
    if (grant.from.deviceId === input.coordinatorDeviceId) yield* snapshot(grant);
    const members = yield* normalized(input.members);
    const previous = yield* transport.selected(input.groupKey);
    const fresh = members.map((member) => member.threadId).filter((id) => !previous.includes(id));
    yield* transport.select(input.groupKey, fresh, true);
    const result = yield* Effect.gen(function* () {
      if (grant.from.deviceId === input.coordinatorDeviceId)
        return sharedGroupSnapshot(
          yield* groups.addSharedMembers({
            groupId: GroupId.make(grant.groupId),
            members,
            clientRequestId: input.clientRequestId,
          }),
        );
      yield* transport.bindRoute(input.groupKey, input.coordinatorDeviceId);
      return yield* call(input, {
        type: "add-chats",
        members,
        clientRequestId: input.clientRequestId,
      });
    }).pipe(
      Effect.tapError(() =>
        cleanup(input, false, fresh).pipe(
          Effect.andThen(transport.select(input.groupKey, fresh, false)),
        ),
      ),
    );
    return yield* view(input, result);
  });
  const removeChats = Effect.fn("SharedGroupService.removeChats")(function* (
    input: SharedGroupRemoveChatsInput,
  ) {
    const grant = yield* access(input);
    const current = yield* call(input, { type: "get" });
    const own = grant.from.deviceId === input.coordinatorDeviceId;
    const result = own
      ? yield* groups.removeMembers({
          groupId: GroupId.make(grant.groupId),
          memberIds: current.members
            .filter(
              (member) =>
                member.environmentId === null && input.threadIds.includes(member.threadId),
            )
            .map((member) => member.id),
          cancelActive: true,
        })
      : yield* call(input, { type: "remove-chats", threadIds: input.threadIds });
    const route = sharedGroupEnvironmentId(input.groupKey, input.coordinatorDeviceId);
    for (const threadId of input.threadIds) {
      const membership = yield* peers.membership(threadId);
      if (membership?.coordinatorEnvironmentId === route) yield* peers.release(membership);
    }
    yield* transport.select(input.groupKey, input.threadIds, false);
    return yield* view(input, result);
  });
  const activityCall = Effect.fn("SharedGroupService.activityCall")(function* (
    input: SharedGroupGetInput,
    request: Extract<SharedGroupPeerCall, { type: "activity" | "activity-get" | "activity-watch" }>,
  ) {
    const grant = yield* access(input);
    let result: SharedGroupPeerResult;
    if (grant.from.deviceId === input.coordinatorDeviceId) {
      if (request.type === "activity")
        yield* writeActivity(input.groupKey, grant.from.deviceId, grant.fromFriendId, request.kind);
      result =
        request.type === "activity-watch"
          ? yield* watchActivity(input.groupKey, request.after)
          : yield* readActivity(input.groupKey);
    } else result = yield* transport.request(input.groupKey, input.coordinatorDeviceId, request);
    yield* access(input);
    return yield* decodeActivity(result).pipe(Effect.mapError(denied));
  });
  const runCall = Effect.fn("SharedGroupService.runCall")(function* (
    input: SharedGroupGetInput,
    request: Extract<SharedGroupPeerCall, { type: "run-page" | "run-item" | "run-body-range" }>,
  ) {
    const grant = yield* access(input);
    const result =
      grant.from.deviceId === input.coordinatorDeviceId
        ? request.type === "run-page"
          ? {
              type: "run-page" as const,
              projection: yield* groups.getRunPage({
                ...request,
                groupId: GroupId.make(grant.groupId),
              }),
            }
          : request.type === "run-item"
            ? {
                type: "run-item" as const,
                result: yield* groups.getRunItem({
                  ...request,
                  groupId: GroupId.make(grant.groupId),
                }),
              }
            : {
                type: "run-body-range" as const,
                result: yield* groups.getRunBodyRange({
                  ...request,
                  groupId: GroupId.make(grant.groupId),
                }),
              }
        : yield* transport.request(input.groupKey, input.coordinatorDeviceId, request);
    yield* access(input);
    return result;
  });
  return SharedGroupService.of({
    respondToRuntimeRequest: Effect.fn("SharedGroupService.respondToRuntimeRequest")(
      function* (input) {
        const grant = yield* access(input);
        if (grant.from.deviceId === input.coordinatorDeviceId) {
          const member = yield* groups.getDeliveryMember({
            groupId: GroupId.make(grant.groupId),
            deliveryId: input.deliveryId,
          });
          if (!(yield* ownsMember(grant, member, grant.fromFriendId, true))) return yield* denied();
          yield* groups.respondToRuntimeRequest({ ...input, groupId: GroupId.make(grant.groupId) });
        } else {
          const byQuestion: Record<string, ReadonlyArray<ChatAttachment>> = {};
          for (const [key, files] of Object.entries(input.attachmentsByQuestionId ?? {}))
            byQuestion[key] = (yield* attachments.transfer({ attachments: files }, (chunk) =>
              transport
                .request(input.groupKey, input.coordinatorDeviceId, {
                  type: "attachment-put",
                  chunk,
                })
                .pipe(
                  Effect.flatMap((result) =>
                    "type" in result && result.type === "attachment-stored"
                      ? Effect.succeed(result.attachment)
                      : Effect.fail(denied()),
                  ),
                ),
            )).attachments;
          const attachmentsByQuestionId = yield* decodeUserInputAttachments(byQuestion).pipe(
            Effect.mapError(denied),
          );
          const result = yield* transport.request(input.groupKey, input.coordinatorDeviceId, {
            type: "runtime-response",
            ...input,
            attachmentsByQuestionId,
          });
          if (!("type" in result) || result.type !== "ok") return yield* denied();
        }
        yield* access(input);
      },
    ),
    getRunAsset: Effect.fn("SharedGroupService.getRunAsset")(function* (input) {
      const grant = yield* access(input);
      if (grant.from.deviceId === input.coordinatorDeviceId)
        return yield* groups.getRunAsset({ ...input, groupId: GroupId.make(grant.groupId) });
      const read = Effect.fn("SharedGroupService.readRunAssetChunk")(function* (offset: number) {
        const result = yield* transport.request(input.groupKey, input.coordinatorDeviceId, {
          type: "run-asset",
          deliveryId: input.deliveryId,
          itemId: input.itemId,
          kind: input.kind,
          ...(input.index === undefined ? {} : { index: input.index }),
          offset,
        });
        if (!("type" in result) || result.type !== "run-asset") return yield* denied();
        return result.chunk;
      });
      let chunk = yield* read(0);
      const scope = `shared-run-asset:${input.groupKey}:${input.deliveryId}`;
      const cached = yield* attachments.cached(scope, chunk.attachment);
      if (cached) return cached;
      let result = yield* attachments.receive(scope, chunk);
      while (!chunk.complete) {
        chunk = yield* read(chunk.offset + Buffer.from(chunk.data, "base64").length);
        result = yield* attachments.receive(scope, chunk);
      }
      yield* access(input);
      return result;
    }),
    getHistory: Effect.fn("SharedGroupService.getHistory")(function* (input) {
      const grant = yield* access(input);
      const result =
        grant.from.deviceId === input.coordinatorDeviceId
          ? yield* groups.getHistory({
              groupId: GroupId.make(grant.groupId),
              ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
            })
          : yield* call(input, {
              type: "history",
              ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
            });
      yield* access(input);
      return yield* view(input, result);
    }),
    getMessageChunk: Effect.fn("SharedGroupService.getMessageChunk")(function* (input) {
      const grant = yield* access(input);
      const result =
        grant.from.deviceId === input.coordinatorDeviceId
          ? yield* groups.getMessageChunk({
              groupId: GroupId.make(grant.groupId),
              messageId: input.messageId,
              offset: input.offset,
            })
          : yield* transport.request(input.groupKey, input.coordinatorDeviceId, {
              type: "message-chunk",
              messageId: input.messageId,
              offset: input.offset,
            });
      yield* access(input);
      return yield* decodeMessageChunk(result).pipe(Effect.mapError(denied));
    }),
    getRunPage: Effect.fn("SharedGroupService.getRunPage")(function* (input) {
      const result = yield* runCall(input, {
        type: "run-page",
        deliveryId: input.deliveryId,
        ...(input.beforeOrdinal === undefined ? {} : { beforeOrdinal: input.beforeOrdinal }),
      });
      if (!("type" in result) || result.type !== "run-page") return yield* denied();
      const grant = yield* access(input);
      if (grant.from.deviceId !== input.coordinatorDeviceId) return result.projection;
      const member = yield* groups.getDeliveryMember({
        groupId: GroupId.make(grant.groupId),
        deliveryId: input.deliveryId,
      });
      return {
        ...result.projection,
        canRespond: yield* ownsMember(grant, member, grant.fromFriendId, true),
      };
    }),
    getRunItem: Effect.fn("SharedGroupService.getRunItem")(function* (input) {
      const result = yield* runCall(input, {
        type: "run-item",
        deliveryId: input.deliveryId,
        itemId: input.itemId,
      });
      if (!("type" in result) || result.type !== "run-item") return yield* denied();
      return result.result;
    }),
    getRunBodyRange: Effect.fn("SharedGroupService.getRunBodyRange")(function* (input) {
      const result = yield* runCall(input, {
        type: "run-body-range",
        deliveryId: input.deliveryId,
        itemId: input.itemId,
        field: input.field,
        before: input.before,
        revision: input.revision,
      });
      if (!("type" in result) || result.type !== "run-body-range") return yield* denied();
      return result.result;
    }),
    publishActivity: Effect.fn("SharedGroupService.publishActivity")((input) =>
      activityCall(input, { type: "activity", kind: input.kind }).pipe(Effect.asVoid),
    ),
    activityStream: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const first = yield* activityCall(input, { type: "activity-get" });
          let revision = sharedGroupContentRevision(first);
          return Stream.concat(
            Stream.succeed(first),
            Stream.fromEffectRepeat(
              Effect.suspend(() =>
                activityCall(input, { type: "activity-watch", after: revision }),
              ).pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    revision = sharedGroupContentRevision(value);
                  }),
                ),
              ),
            ),
          );
        }),
      ),
    get,
    addChats,
    removeChats,
    send: Effect.fn("SharedGroupService.send")(function* (input) {
      const grant = yield* access(input);
      if (grant.from.deviceId === input.coordinatorDeviceId) yield* snapshot(grant);
      if (
        grant.from.deviceId !== input.coordinatorDeviceId &&
        (input.attachments?.length ||
          input.context?.records.length ||
          input.interactionMode !== undefined)
      ) {
        const capability = yield* transport.request(input.groupKey, input.coordinatorDeviceId, {
          type: "capabilities",
        });
        if (
          !("type" in capability) ||
          capability.type !== "capabilities" ||
          !capability.supportsRichMessages
        )
          return yield* new GroupChatError({
            code: "unsupported",
            message:
              "The group coordinator could not confirm support for files, context, or Plan mode. Update or reconnect its host; your draft was kept.",
          });
      }
      const payload =
        grant.from.deviceId === input.coordinatorDeviceId
          ? input
          : yield* attachments.transfer(input, (chunk) =>
              transport
                .request(input.groupKey, input.coordinatorDeviceId, {
                  type: "attachment-put",
                  chunk,
                })
                .pipe(
                  Effect.flatMap((result) =>
                    "type" in result && result.type === "attachment-stored"
                      ? Effect.succeed(result.attachment)
                      : Effect.fail(denied()),
                  ),
                ),
            );
      const value =
        grant.from.deviceId === input.coordinatorDeviceId
          ? yield* groups.sendShared(
              {
                groupId: GroupId.make(grant.groupId),
                message: input.message,
                ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
                ...(payload.attachments ? { attachments: payload.attachments } : {}),
                ...(payload.context ? { context: payload.context } : {}),
                clientRequestId: input.clientRequestId,
                requestAiResponse: input.requestAiResponse ?? false,
              },
              grant.fromFriendId,
            )
          : yield* call(input, {
              type: "send",
              ...("contextFile" in payload && payload.contextFile
                ? { contextFile: payload.contextFile }
                : {}),
              message: input.message,
              ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
              ...(payload.attachments ? { attachments: payload.attachments } : {}),
              ...(payload.context ? { context: payload.context } : {}),
              clientRequestId: input.clientRequestId,
              requestAiResponse: input.requestAiResponse ?? false,
            });
      yield* access(input);
      return yield* view(input, value);
    }),
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const first = yield* get(input);
          if (!first.snapshot) return Stream.succeed(first);
          let revision = sharedGroupRevision(first.snapshot);
          return Stream.concat(
            Stream.succeed(first),
            Stream.fromEffectRepeat(
              Effect.suspend(() => call(input, { type: "watch", after: revision })).pipe(
                Effect.map((value) => {
                  revision = sharedGroupRevision(value);
                  return value;
                }),
                Effect.flatMap((value) => view(input, value)),
              ),
            ).pipe(
              Stream.catch(() =>
                Stream.succeed({
                  status: "offline" as const,
                  snapshot: null,
                  selectedThreadIds: [] as ReadonlyArray<ThreadId>,
                }),
              ),
            ),
          );
        }),
      ),
    leave: Effect.fn("SharedGroupService.leave")(function* (input) {
      yield* clearActivity(input.groupKey, yield* ownDevice);
      const selected = yield* transport.selected(input.groupKey);
      yield* removeChats({ ...input, threadIds: selected }).pipe(
        Effect.catchIf(
          (error) => error.code === "dispatch" || error.code === "not-group-turn",
          () => Effect.void,
        ),
      );
      yield* cleanup(input, true);
      yield* transport.disconnect(input.groupKey);
    }),
  });
});
export const layer = Layer.effect(SharedGroupService, make);
