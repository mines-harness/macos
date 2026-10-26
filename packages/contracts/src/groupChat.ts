import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { CatalogContextRevision } from "./catalogRpc.ts";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const GroupId = TrimmedNonEmptyString.pipe(Schema.brand("GroupId"));
export type GroupId = typeof GroupId.Type;
export const GroupWorkflow = Schema.Literals(["compare", "team", "build-review", "council"]);
export type GroupWorkflow = typeof GroupWorkflow.Type;
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const Alias = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/));
const MessageText = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));

export const GroupMemberInput = Schema.Struct({
  threadId: ThreadId,
  alias: Alias,
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  environmentId: Schema.optional(EnvironmentId),
});
export const GroupMember = Schema.Struct({
  id: Schema.String,
  groupId: GroupId,
  threadId: ThreadId,
  projectId: ProjectId,
  environmentId: Schema.NullOr(EnvironmentId),
  alias: Alias,
  role: Schema.String,
  modelSelection: ModelSelection,
  joinedAt: IsoDateTime,
});
export type GroupMember = typeof GroupMember.Type;

export const Group = Schema.Struct({
  id: GroupId,
  name: TrimmedNonEmptyString,
  workflow: GroupWorkflow,
  leadMemberId: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  visibility: Schema.optionalKey(Schema.Literals(["private", "shared"])),
});
export type Group = typeof Group.Type;
export const GroupDeliveryStatus = Schema.Literals([
  "assessing",
  "ready",
  "dispatching",
  "queued",
  "running",
  "completed",
  "silent",
  "unavailable",
  "failed",
  "cancelled",
]);
export type GroupDeliveryStatus = typeof GroupDeliveryStatus.Type;
export const GroupDelivery = Schema.Struct({
  id: Schema.String,
  memberId: Schema.String,
  stage: Schema.Literals(["initial", "review", "critique", "synthesis", "fix", "handoff"]),
  status: GroupDeliveryStatus,
  runId: Schema.NullOr(RunId),
  contextContinuationOfRunId: Schema.optional(RunId),
  hop: Schema.Number,
  parentDeliveryId: Schema.NullOr(Schema.String),
  request: Schema.String,
  contextThroughMessageId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type GroupDelivery = typeof GroupDelivery.Type;
export const GroupRound = Schema.Struct({
  catalogContextRevision: Schema.optional(CatalogContextRevision),
  id: Schema.String,
  groupId: GroupId,
  userMessageId: Schema.String,
  routing: Schema.Literals(["everyone", "targeted", "self-select", "workflow"]),
  workflow: GroupWorkflow,
  status: Schema.Literals(["active", "completed", "cancelled"]),
  members: Schema.Array(GroupMember),
  deliveries: Schema.Array(GroupDelivery),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GroupRound = typeof GroupRound.Type;
export const GroupMessage = Schema.Struct({
  authorFriendId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  groupId: GroupId,
  roundId: Schema.NullOr(Schema.String),
  memberId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["user", "assistant", "handoff", "system"]),
  text: Schema.String,
  createdAt: IsoDateTime,
  truncated: Schema.Boolean,
});
export type GroupMessage = typeof GroupMessage.Type;
export const GroupSnapshot = Schema.Struct({
  group: Group,
  members: Schema.Array(GroupMember),
  messages: Schema.Array(GroupMessage),
  rounds: Schema.Array(GroupRound),
  hasMoreMessages: Schema.Boolean,
});
export type GroupSnapshot = typeof GroupSnapshot.Type;
export const GroupMembershipRef = Schema.Struct({
  groupId: GroupId,
  threadId: ThreadId,
  environmentId: Schema.NullOr(EnvironmentId),
});
export type GroupMembershipRef = typeof GroupMembershipRef.Type;
export const GroupListResult = Schema.Struct({
  groups: Schema.Array(Group),
  memberships: Schema.Array(GroupMembershipRef).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type GroupListResult = typeof GroupListResult.Type;
export const GroupGetInput = Schema.Struct({ groupId: GroupId });
export const GroupCreateInput = Schema.Struct({
  visibility: Schema.optionalKey(Schema.Literals(["private", "shared"])),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  workflow: GroupWorkflow,
  members: Schema.Array(GroupMemberInput).check(Schema.isMaxLength(12)),
  leadThreadId: Schema.optional(ThreadId),
  leadEnvironmentId: Schema.optional(EnvironmentId),
  clientRequestId: RequestId,
});
export type GroupCreateInput = typeof GroupCreateInput.Type;
export const GroupAddMembersInput = Schema.Struct({
  groupId: GroupId,
  members: Schema.Array(GroupMemberInput).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  clientRequestId: RequestId,
});
export type GroupAddMembersInput = typeof GroupAddMembersInput.Type;
export const GroupSendInput = Schema.Struct({
  requestAiResponse: Schema.optionalKey(Schema.Boolean),
  catalogContextRevision: Schema.optional(CatalogContextRevision),
  groupId: GroupId,
  message: MessageText,
  recipientMemberIds: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(12))),
  mentionEveryone: Schema.optional(Schema.Boolean),
  clientRequestId: RequestId,
});
export type GroupSendInput = typeof GroupSendInput.Type;
export const GroupStopInput = Schema.Struct({
  groupId: GroupId,
  roundId: Schema.optional(Schema.String),
});
export const GroupArchiveInput = Schema.Struct({ groupId: GroupId, archived: Schema.Boolean });
export const GroupRetryInput = Schema.Struct({
  groupId: GroupId,
  roundId: Schema.String,
  deliveryId: Schema.String,
});
export const GroupAskInput = Schema.Struct({
  targetMemberId: Schema.String,
  message: MessageText,
  clientRequestId: RequestId,
});
export type GroupAskInput = typeof GroupAskInput.Type;
export const GroupAskResult = Schema.Struct({
  groupId: GroupId,
  roundId: Schema.String,
  deliveryId: Schema.String,
});
export type GroupAskResult = typeof GroupAskResult.Type;

const PeerMembershipFields = { groupId: GroupId, memberId: RequestId, threadId: ThreadId };
/** Called only over a paired host session; caller identity comes from that session. */
export const GroupPeerRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("describe"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("reserve"), ...PeerMembershipFields }),
  Schema.Struct({ type: Schema.Literal("release"), ...PeerMembershipFields }),
  Schema.Struct({
    type: Schema.Literal("assess"),
    ...PeerMembershipFields,
    role: Schema.String.check(Schema.isMaxLength(600)),
    context: Schema.String.check(Schema.isMaxLength(40_000)),
    message: MessageText,
  }),
  Schema.Struct({
    type: Schema.Literal("dispatch"),
    ...PeerMembershipFields,
    deliveryId: RequestId,
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(160_000)),
    handoff: Schema.Boolean,
    contextContinuationOfRunId: Schema.optional(RunId),
    catalogContextRevision: Schema.optional(CatalogContextRevision),
  }),
  Schema.Struct({ type: Schema.Literal("read"), ...PeerMembershipFields, deliveryId: RequestId }),
  Schema.Struct({
    type: Schema.Literal("interrupt"),
    ...PeerMembershipFields,
    deliveryId: RequestId,
  }),
  Schema.Struct({ type: Schema.Literal("ask"), ...PeerMembershipFields, input: GroupAskInput }),
  Schema.Struct({ type: Schema.Literal("changed"), ...PeerMembershipFields }),
]);
export type GroupPeerRequest = typeof GroupPeerRequest.Type;
export const GroupPeerResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ok") }),
  Schema.Struct({
    type: Schema.Literal("description"),
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    type: Schema.Literal("assessment"),
    decision: Schema.Literals(["reply", "silent"]),
  }),
  Schema.Struct({ type: Schema.Literal("dispatch"), runId: RunId, queued: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("run"),
    runId: RunId,
    status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
    text: Schema.String.check(Schema.isMaxLength(120_000)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("ask"), result: GroupAskResult }),
]);
export type GroupPeerResponse = typeof GroupPeerResponse.Type;
export class GroupChatError extends Schema.TaggedError<GroupChatError>()("GroupChatError", {
  code: Schema.Literals([
    "not-found",
    "invalid-members",
    "already-grouped",
    "unsupported",
    "busy",
    "discussion-limit",
    "not-group-turn",
    "storage",
    "dispatch",
  ]),
  message: Schema.String,
}) {}

/** An authenticated host origin, bound to both approved device keys and the destination. */
export const GroupPeerEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  fromEnvironmentId: EnvironmentId,
  toEnvironmentId: EnvironmentId,
  fromDeviceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
  toDeviceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
  issuedAt: Schema.Int,
  nonce: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(80)),
  request: GroupPeerRequest,
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
});
export type GroupPeerEnvelope = typeof GroupPeerEnvelope.Type;
export const GroupConnectHostInput = Schema.Struct({
  environmentId: EnvironmentId,
  deviceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
  pairingCode: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type GroupConnectHostInput = typeof GroupConnectHostInput.Type;
export const GroupHostRoute = Schema.Struct({
  environmentId: EnvironmentId,
  deviceId: Schema.String,
  label: Schema.String,
});
export type GroupHostRoute = typeof GroupHostRoute.Type;
export const GroupHostRoutes = Schema.Struct({ routes: Schema.Array(GroupHostRoute) });
export const GroupDisconnectHostInput = Schema.Struct({ environmentId: EnvironmentId });
