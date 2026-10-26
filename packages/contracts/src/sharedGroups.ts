import * as Schema from "effect/Schema";
import { ContactGroupKey } from "./contacts.ts";
import { PeerDevice } from "./minesPeer.ts";
import {
  GroupMemberInput,
  GroupPeerRequest,
  GroupPeerResponse,
  GroupSnapshot,
} from "./groupChat.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Address = {
  groupKey: ContactGroupKey,
  coordinatorDeviceId: PeerDevice.fields.deviceId,
};
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const SharedGroupGetInput = Schema.Struct(Address);
export type SharedGroupGetInput = typeof SharedGroupGetInput.Type;
export const SharedGroupView = Schema.Struct({
  status: Schema.Literals(["online", "offline"]),
  snapshot: Schema.NullOr(GroupSnapshot),
  selectedThreadIds: Schema.Array(ThreadId),
});
export type SharedGroupView = typeof SharedGroupView.Type;
export const SharedGroupSendInput = Schema.Struct({
  requestAiResponse: Schema.optionalKey(Schema.Boolean),
  ...Address,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  clientRequestId: RequestId,
});
export type SharedGroupSendInput = typeof SharedGroupSendInput.Type;
export const SharedGroupAddChatsInput = Schema.Struct({
  ...Address,
  members: Schema.Array(GroupMemberInput).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  clientRequestId: RequestId,
});
export type SharedGroupAddChatsInput = typeof SharedGroupAddChatsInput.Type;
export const SharedGroupRemoveChatsInput = Schema.Struct({
  ...Address,
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(12)),
});
export type SharedGroupRemoveChatsInput = typeof SharedGroupRemoveChatsInput.Type;

export const SharedGroupPeerCall = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get") }),
  Schema.Struct({
    type: Schema.Literal("send"),
    message: SharedGroupSendInput.fields.message,
    clientRequestId: RequestId,
    requestAiResponse: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("add-chats"),
    members: SharedGroupAddChatsInput.fields.members,
    clientRequestId: RequestId,
  }),
  Schema.Struct({
    type: Schema.Literal("remove-chats"),
    threadIds: SharedGroupRemoveChatsInput.fields.threadIds,
  }),
  Schema.Struct({ type: Schema.Literal("native"), request: GroupPeerRequest }),
  Schema.Struct({
    type: Schema.Literal("watch"),
    after: Schema.String.check(Schema.isMaxLength(128)),
  }),
]);
export type SharedGroupPeerCall = typeof SharedGroupPeerCall.Type;
export const SharedGroupPeerResult = Schema.Union([GroupSnapshot, GroupPeerResponse]);
export type SharedGroupPeerResult = typeof SharedGroupPeerResult.Type;
