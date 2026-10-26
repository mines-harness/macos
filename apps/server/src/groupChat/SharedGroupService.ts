import {
  GroupChatError,
  GroupId,
  GroupSnapshot,
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
} from "@t3tools/contracts/sharedGroups";
import { sharedGroupContentRevision } from "@t3tools/shared/minesSharedGroupAccess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
  const transport = yield* SharedGroupTransport.SharedGroupTransport;
  const peers = yield* GroupPeerStore.GroupPeerStore;
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const ownDevice = trust.identity.pipe(
    Effect.map((identity) => identity.device.deviceId),
    Effect.mapError(denied),
  );
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
  const snapshot = Effect.fn("SharedGroupService.snapshot")(function* (
    grant: SharedGroupDeviceGrant,
  ) {
    const result = yield* groups.get({ groupId: GroupId.make(grant.groupId) });
    if (result.group.visibility !== "shared" || grant.coordinatorEnvironmentId !== environmentId)
      return yield* denied();
    return sharedGroupSnapshot(result);
  });
  const watch = Effect.fn("SharedGroupService.watch")(function* (
    grant: SharedGroupDeviceGrant,
    after: string,
  ) {
    const next = yield* groups.subscribe({ groupId: GroupId.make(grant.groupId) }).pipe(
      Stream.filter((value) => sharedGroupRevision(value) !== after),
      Stream.runHead,
    );
    if (Option.isNone(next)) return yield* unavailable();
    if (next.value.group.visibility !== "shared") return yield* denied();
    return sharedGroupSnapshot(next.value);
  });
  const peer = Effect.fn("SharedGroupService.peer")(function* (
    grant: SharedGroupDeviceGrant,
    call: SharedGroupPeerCall,
  ): Effect.fn.Return<SharedGroupPeerResult, GroupChatError> {
    const deviceId = yield* ownDevice;
    const coordinator = grant.coordinatorDevice.deviceId;
    const groupId = GroupId.make(grant.groupId);
    if (deviceId === coordinator) {
      const current = yield* snapshot(grant);
      const route = sharedGroupEnvironmentId(grant.groupKey, grant.to.deviceId);
      if (route === environmentId) return yield* denied();
      switch (call.type) {
        case "get":
          return current;
        case "watch":
          return yield* watch(grant, call.after);
        case "send":
          return sharedGroupSnapshot(
            yield* groups.sendShared(
              {
                groupId,
                message: call.message,
                clientRequestId: sharedGroupContentRevision([
                  grant.to.deviceId,
                  call.clientRequestId,
                ]),
                requestAiResponse: call.requestAiResponse ?? false,
              },
              grant.toFriendId,
            ),
          );
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
  const unregister = transport.register(peer, (grant, revoked) =>
    cleanup(
      { groupKey: grant.groupKey, coordinatorDeviceId: grant.coordinatorDevice.deviceId },
      revoked,
    ),
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
    return {
      status: "online",
      snapshot: sharedGroupSnapshot(value),
      selectedThreadIds: yield* transport.selected(input.groupKey),
    };
  });
  const get = Effect.fn("SharedGroupService.get")(function* (input: SharedGroupGetInput) {
    return yield* call(input, { type: "get" }).pipe(
      Effect.flatMap((value) => view(input, value)),
      Effect.catch((error) =>
        error.code === "dispatch"
          ? Effect.succeed({
              status: "offline" as const,
              snapshot: null,
              selectedThreadIds: [] as ReadonlyArray<ThreadId>,
            })
          : Effect.fail(error),
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
  return SharedGroupService.of({
    get,
    addChats,
    removeChats,
    send: Effect.fn("SharedGroupService.send")(function* (input) {
      const grant = yield* access(input);
      const value =
        grant.from.deviceId === input.coordinatorDeviceId
          ? yield* groups.sendShared(
              {
                groupId: GroupId.make(grant.groupId),
                message: input.message,
                clientRequestId: input.clientRequestId,
                requestAiResponse: input.requestAiResponse ?? false,
              },
              grant.fromFriendId,
            )
          : yield* call(input, {
              type: "send",
              message: input.message,
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
