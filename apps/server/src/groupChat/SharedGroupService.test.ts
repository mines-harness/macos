import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GroupChatError,
  GroupId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type GroupSnapshot,
  type GroupSendInput,
  type GroupPeerRequest,
} from "@t3tools/contracts";
import type { SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as GroupChatService from "./GroupChatService.ts";
import * as GroupPeerStore from "./GroupPeerStore.ts";
import * as SharedGroupTransport from "./SharedGroupTransport.ts";
import * as GroupAttachments from "./GroupAttachments.ts";
import * as SharedGroupService from "./SharedGroupService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerTrustStore from "../peer/PeerTrustStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { sharedGroupEnvironmentId, sharedGroupRevision } from "./sharedGroupPolicy.ts";

const fixture = (coordinator = true) => {
  const owner = createPeerIdentity(new Uint8Array(32).fill(21), "Owner");
  const friend = createPeerIdentity(new Uint8Array(32).fill(22), "Friend");
  const identity = coordinator ? owner : friend;
  const groupId = GroupId.make("group:shared");
  const environmentId = EnvironmentId.make(
    coordinator ? "owner-environment" : "friend-environment",
  );
  const at = IsoDateTime.make("2026-10-26T00:00:00.000Z");
  const input = { groupKey: "group-key-123456789", coordinatorDeviceId: owner.device.deviceId };
  const selected = ThreadId.make("selected");
  const other = ThreadId.make("private-unselected");
  let selections: ReadonlyArray<ThreadId> = [selected, other];
  let revoked = false;
  let offline = false;
  let addingFails = false;
  let handler: Parameters<
    SharedGroupTransport.SharedGroupTransport["Service"]["register"]
  >[0] = () => Effect.die("Missing handler");
  let cleanup: Parameters<
    SharedGroupTransport.SharedGroupTransport["Service"]["register"]
  >[1] = () => Effect.die("Missing cleanup");
  const snapshot: GroupSnapshot = {
    group: {
      id: groupId,
      name: "Shared",
      visibility: "shared",
      workflow: "team",
      leadMemberId: "",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    },
    members: [],
    messages: [],
    rounds: [],
    hasMoreMessages: false,
  };
  const grant = (remote = coordinator ? friend.device : owner.device): SharedGroupDeviceGrant => ({
    groupKey: input.groupKey,
    groupId,
    coordinatorEnvironmentId: "owner-environment",
    coordinatorDevice: owner.device,
    from: identity.device,
    to: remote,
    fromFriendId: coordinator ? "mines-aaaaaaaaaaaaaaaaaaaa" : "mines-bbbbbbbbbbbbbbbbbbbb",
    toFriendId:
      remote.deviceId === owner.device.deviceId
        ? "mines-aaaaaaaaaaaaaaaaaaaa"
        : "mines-bbbbbbbbbbbbbbbbbbbb",
    updatedAt: at,
  });
  const sends: Array<{ input: GroupSendInput; author: string }> = [];
  const native: Array<{ environmentId: EnvironmentId; request: GroupPeerRequest }> = [];
  const additions: ReadonlyArray<unknown>[] = [];
  const responses: Array<unknown> = [];
  const requests: string[] = [];
  const removals: Array<{
    groupId: GroupId;
    memberIds: ReadonlyArray<string>;
    cancelActive?: boolean;
  }> = [];
  let revokedRoutes: ReadonlyArray<EnvironmentId> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(GroupAttachments.GroupAttachments)({}),
    GroupPeerStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
    Layer.mock(GroupChatService.GroupChatService)({
      get: () => Effect.succeed(snapshot),
      getDeliveryMember: () =>
        snapshot.members[0]
          ? Effect.succeed(snapshot.members[0])
          : Effect.fail(new GroupChatError({ code: "not-found", message: "Missing member" })),
      respondToRuntimeRequest: (input) =>
        Effect.sync(() => {
          responses.push(input);
        }),
      subscribe: () => Stream.succeed(snapshot),
      sendShared: (input, author) =>
        Effect.sync(() => {
          sends.push({ input, author });
          return snapshot;
        }),
      addSharedMembers: (input) =>
        Effect.sync(() => {
          additions.push(input.members);
          return snapshot;
        }),
      removeMembers: (input) =>
        Effect.sync(() => {
          removals.push(input);
          Object.assign(snapshot, {
            members: snapshot.members.filter((member) => !input.memberIds.includes(member.id)),
          });
          return snapshot;
        }),
      peer: (environmentId, request) =>
        Effect.sync(() => {
          native.push({ environmentId, request });
          return { type: "ok" as const };
        }),
    }),
    Layer.mock(PeerTrustStore.PeerTrustStore)({ identity: Effect.succeed(identity) }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(SharedGroupTransport.SharedGroupTransport, {
      register: (next, onDisconnect) => {
        handler = next;
        cleanup = onDisconnect;
        return () => {};
      },
      authorize: () =>
        Effect.suspend(() =>
          revoked
            ? Effect.fail(new GroupChatError({ code: "not-group-turn", message: "Revoked" }))
            : offline
              ? Effect.fail(new GroupChatError({ code: "dispatch", message: "Offline" }))
              : Effect.succeed(grant(owner.device)),
        ),
      request: (_key, _device, call) =>
        Effect.suspend(() => {
          requests.push(call.type);
          return offline || (addingFails && call.type === "add-chats")
            ? Effect.fail(new GroupChatError({ code: "dispatch", message: "Offline" }))
            : Effect.succeed(snapshot);
        }),
      selected: () => Effect.sync(() => selections),
      routeFriendId: () => Effect.succeed("mines-bbbbbbbbbbbbbbbbbbbb"),
      revokedRoutes: () => Effect.sync(() => revokedRoutes),
      select: (_key, ids, selected) =>
        Effect.sync(() => {
          selections = selected
            ? [...new Set([...selections, ...ids])]
            : selections.filter((id) => !ids.includes(id));
        }),
      bindRoute: (key, device) => Effect.succeed(sharedGroupEnvironmentId(key, device)),
      native: () => Effect.die("No private transport access"),
      disconnect: () => Effect.void,
    }),
  );
  return {
    input,
    selected,
    other,
    groupId,
    snapshot,
    grant,
    sends,
    native,
    additions,
    responses,
    requests,
    removals,
    revokeRoutes: (routes: ReadonlyArray<EnvironmentId>) => {
      revokedRoutes = routes;
    },
    environmentId,
    get selections() {
      return selections;
    },
    revoke: () => {
      revoked = true;
    },
    failAdding: () => {
      addingFails = true;
    },
    offline: () => {
      offline = true;
    },
    handle: (call: Parameters<typeof handler>[1]) => handler(grant(), call),
    disconnected: (revoked: boolean) => cleanup(grant(), revoked),
    layer: Layer.merge(SharedGroupService.layer.pipe(Layer.provide(dependencies)), dependencies),
  };
};

describe("shared group service", () => {
  it.effect("does not treat viewer-specific response authority as a new watch event", () => {
    const h = fixture();
    const member = {
      id: "member",
      groupId: h.groupId,
      threadId: h.selected,
      projectId: ProjectId.make("project"),
      environmentId: null,
      alias: "writer",
      role: "",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
      joinedAt: h.snapshot.group.createdAt,
    };
    Object.assign(h.snapshot, {
      members: [member],
      runProjections: [
        {
          deliveryId: "delivery",
          memberId: member.id,
          environmentId: h.environmentId,
          threadId: h.selected,
          runId: RunId.make("run"),
          items: [],
          runtimeRequests: [],
          deferredItems: [],
          hasMoreItems: false,
          beforeOrdinal: null,
          canRespond: true,
        },
      ],
    });
    return Effect.gen(function* () {
      yield* SharedGroupService.SharedGroupService;
      const initial = yield* h.handle({ type: "get" });
      if (!("members" in initial)) throw new Error("Expected snapshot");
      expect(initial.runProjections?.[0]?.canRespond).toBe(false);
      const result = yield* h
        .handle({ type: "watch", after: sharedGroupRevision(initial) })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("allows only the owning human to answer a contributed mine's runtime request", () => {
    const h = fixture();
    const member = {
      id: "member",
      groupId: h.groupId,
      threadId: h.selected,
      projectId: ProjectId.make("project"),
      environmentId: null as EnvironmentId | null,
      alias: "writer",
      role: "",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
      joinedAt: h.snapshot.group.createdAt,
    };
    Object.assign(h.snapshot, { members: [member] });
    const response = {
      deliveryId: "delivery",
      requestId: RuntimeRequestId.make("request"),
      clientRequestId: "answer",
      decision: "accept" as const,
    };
    return Effect.gen(function* () {
      const service = yield* SharedGroupService.SharedGroupService;
      yield* h.handle({ type: "runtime-response", ...response }).pipe(Effect.flip);
      expect(h.responses).toEqual([]);
      yield* service.respondToRuntimeRequest({ ...h.input, ...response });
      expect(h.responses).toHaveLength(1);
      Object.assign(h.snapshot, {
        members: [
          {
            ...member,
            environmentId: sharedGroupEnvironmentId(h.input.groupKey, h.grant().to.deviceId),
          },
        ],
      });
      yield* service.respondToRuntimeRequest({ ...h.input, ...response }).pipe(Effect.flip);
      expect(h.responses).toHaveLength(1);
      yield* h.handle({ type: "runtime-response", ...response });
      expect(h.responses).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "refuses rich sends before acceptance when an older coordinator cannot advertise support",
    () => {
      const h = fixture(false);
      return Effect.gen(function* () {
        const service = yield* SharedGroupService.SharedGroupService;
        const failure = yield* service
          .send({
            ...h.input,
            message: "Plan this",
            interactionMode: "plan",
            clientRequestId: "rich-old",
          })
          .pipe(Effect.flip);
        expect(failure.code).toBe("unsupported");
        expect(h.requests).toEqual(["capabilities"]);
        expect(h.sends).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "attributes typing to the verified friend and expires it without persisting conversation events",
    () => {
      const h = fixture();
      return Effect.gen(function* () {
        const service = yield* SharedGroupService.SharedGroupService;
        yield* h.handle({ type: "activity", kind: "typing" });
        const current = yield* service.activityStream(h.input).pipe(Stream.runHead);
        expect(Option.getOrThrow(current).participants).toMatchObject([
          { friendId: h.grant().toFriendId, kind: "typing" },
        ]);
        yield* TestClock.adjust("8 seconds");
        expect(
          Option.getOrThrow(yield* service.activityStream(h.input).pipe(Stream.runHead))
            .participants,
        ).toEqual([]);
        expect(h.sends).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("removes every mine from revoked device routes and preserves the other members", () => {
    const h = fixture();
    const revoked = sharedGroupEnvironmentId(h.input.groupKey, h.grant().to.deviceId);
    const anotherDevice = sharedGroupEnvironmentId(h.input.groupKey, "another-removed-device");
    const keep = sharedGroupEnvironmentId(h.input.groupKey, "remaining-friend");
    const member = (id: string, environmentId: EnvironmentId | null) => ({
      id,
      groupId: h.groupId,
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project"),
      environmentId,
      alias: id,
      role: "",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      joinedAt: h.snapshot.group.createdAt,
    });
    Object.assign(h.snapshot, {
      members: [
        member("removedone", revoked),
        member("removedtwo", revoked),
        member("removedotherdevice", anotherDevice),
        member("friend", keep),
        member("owner", null),
      ],
    });
    h.revokeRoutes([revoked, anotherDevice]);
    return Effect.gen(function* () {
      const service = yield* SharedGroupService.SharedGroupService;
      const result = yield* service.get(h.input);
      expect(result.snapshot?.members.map((member) => member.id)).toEqual(["friend", "owner"]);
      expect(h.removals).toEqual([
        {
          groupId: h.groupId,
          memberIds: ["removedone", "removedtwo", "removedotherdevice"],
          cancelActive: true,
        },
      ]);
      yield* service.get(h.input);
      expect(h.removals).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("preserves prior selections and reservations when adding another chat fails", () => {
    const h = fixture(false);
    return Effect.gen(function* () {
      const service = yield* SharedGroupService.SharedGroupService;
      const peers = yield* GroupPeerStore.GroupPeerStore;
      const membership = {
        coordinatorEnvironmentId: sharedGroupEnvironmentId(
          h.input.groupKey,
          h.input.coordinatorDeviceId,
        ),
        groupId: h.groupId,
        memberId: "existing",
        threadId: h.selected,
      };
      yield* peers.reserve(membership);
      h.failAdding();
      const fresh = ThreadId.make("fresh-failed");
      yield* service
        .addChats({
          ...h.input,
          members: [{ threadId: fresh, alias: "newchat" }],
          clientRequestId: "failed-add",
        })
        .pipe(Effect.flip);
      expect(yield* peers.membership(h.selected)).toEqual(membership);
      expect(h.selections).toEqual([h.selected, h.other]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("attributes remote human notes to the verified friend and defaults AI off", () => {
    const h = fixture();
    return Effect.gen(function* () {
      yield* SharedGroupService.SharedGroupService;
      yield* h.handle({ type: "send", message: "@writer just a note", clientRequestId: "note" });
      expect(h.sends).toMatchObject([
        { author: "mines-bbbbbbbbbbbbbbbbbbbb", input: { requestAiResponse: false } },
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("uses registered owner identity for local sends and requires explicit Ask AI", () => {
    const h = fixture();
    return Effect.gen(function* () {
      const service = yield* SharedGroupService.SharedGroupService;
      yield* service.send({ ...h.input, message: "A note", clientRequestId: "note" });
      yield* service.send({
        ...h.input,
        message: "Help",
        clientRequestId: "ask",
        requestAiResponse: true,
      });
      expect(h.sends.map((item) => [item.author, item.input.requestAiResponse])).toEqual([
        ["mines-aaaaaaaaaaaaaaaaaaaa", false],
        ["mines-aaaaaaaaaaaaaaaaaaaa", true],
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("rejects falsely local chat offers and device-binds an unqualified thread ID", () => {
    const h = fixture();
    return Effect.gen(function* () {
      yield* SharedGroupService.SharedGroupService;
      const member = { threadId: h.selected, alias: "writer" };
      yield* h
        .handle({
          type: "add-chats",
          members: [{ ...member, environmentId: h.environmentId }],
          clientRequestId: "spoof",
        })
        .pipe(Effect.flip);
      expect(h.additions).toEqual([]);
      yield* h.handle({ type: "add-chats", members: [member], clientRequestId: "valid" });
      expect(h.additions).toEqual([
        [
          {
            ...member,
            environmentId: sharedGroupEnvironmentId(h.input.groupKey, h.grant().to.deviceId),
          },
        ],
      ]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "allows native access only to explicitly selected own chats and strips private catalog context",
    () => {
      const h = fixture(false);
      return Effect.gen(function* () {
        yield* SharedGroupService.SharedGroupService;
        yield* h
          .handle({
            type: "native",
            request: { type: "describe", threadId: ThreadId.make("not-selected") },
          })
          .pipe(Effect.flip);
        expect(h.native).toEqual([]);
        yield* h.handle({
          type: "native",
          request: {
            type: "dispatch",
            groupId: h.groupId,
            memberId: "member",
            threadId: h.selected,
            deliveryId: "delivery",
            prompt: "Explicit AI",
            handoff: false,
            catalogContextRevision: { accountId: "private-account", stateVector: "AA==" },
          },
        });
        expect(h.native.at(-1)?.request).not.toHaveProperty("catalogContextRevision");
        expect(h.native.at(-1)?.environmentId).toBe(
          sharedGroupEnvironmentId(h.input.groupKey, h.input.coordinatorDeviceId),
        );
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "leaves offline without orphaning own reservations or releasing unrelated groups",
    () => {
      const h = fixture(false);
      return Effect.gen(function* () {
        const service = yield* SharedGroupService.SharedGroupService;
        const peers = yield* GroupPeerStore.GroupPeerStore;
        yield* peers.reserve({
          coordinatorEnvironmentId: sharedGroupEnvironmentId(
            h.input.groupKey,
            h.input.coordinatorDeviceId,
          ),
          groupId: h.groupId,
          memberId: "mine",
          threadId: h.selected,
        });
        yield* peers.reserve({
          coordinatorEnvironmentId: EnvironmentId.make("private-host"),
          groupId: GroupId.make("other-group"),
          memberId: "other",
          threadId: h.other,
        });
        h.offline();
        yield* service.leave(h.input);
        expect(yield* peers.membership(h.selected)).toBeUndefined();
        expect(yield* peers.membership(h.other)).toBeDefined();
        expect(h.selections).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "releases offline reservations but preserves consent, then clears it on revocation",
    () => {
      const h = fixture(false);
      return Effect.gen(function* () {
        yield* SharedGroupService.SharedGroupService;
        const peers = yield* GroupPeerStore.GroupPeerStore;
        const membership = {
          coordinatorEnvironmentId: sharedGroupEnvironmentId(
            h.input.groupKey,
            h.input.coordinatorDeviceId,
          ),
          groupId: h.groupId,
          memberId: "mine",
          threadId: h.selected,
        };
        yield* peers.reserve(membership);
        yield* h.disconnected(false);
        expect(yield* peers.membership(h.selected)).toBeUndefined();
        expect(h.selections).toContain(h.selected);
        yield* peers.reserve(membership);
        h.revoke();
        const service = yield* SharedGroupService.SharedGroupService;
        yield* service.get(h.input).pipe(Effect.flip);
        expect(yield* peers.membership(h.selected)).toBeUndefined();
        expect(h.selections).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
});
