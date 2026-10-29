import * as Schema from "effect/Schema";
import { ContactGroupKey, ContactFriendId } from "./contacts.ts";
import { PeerDevice } from "./minesPeer.ts";
import {
  GroupMemberInput,
  GroupPayloadFields,
  GroupPeerPayloadFields,
  GroupAttachmentChunk,
  GroupHistoryFields,
  GroupMessageChunkFields,
  GroupMessageChunk,
  GroupRunPageFields,
  GroupRunItemFields,
  GroupRunBodyFields,
  GroupRunAssetFields,
  GroupRunRespondFields,
  GroupPeerRequest,
  GroupPeerResponse,
  GroupSnapshot,
} from "./groupChat.ts";
import { ThreadId, TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas.ts";

import { ConversationActivityKind } from "./conversationActivity.ts";

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
  ...GroupPayloadFields,
  requestAiResponse: Schema.optionalKey(Schema.Boolean),
  ...Address,
  message: Schema.String.check(Schema.isMaxLength(120_000)),
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

export const SharedGroupActivityInput = Schema.Struct({
  ...Address,
  kind: ConversationActivityKind,
});
export type SharedGroupActivityInput = typeof SharedGroupActivityInput.Type;
export const SharedGroupActivityView = Schema.Struct({
  participants: Schema.Array(
    Schema.Struct({
      friendId: ContactFriendId,
      kind: ConversationActivityKind,
      expiresAt: IsoDateTime,
    }),
  ),
});
export type SharedGroupActivityView = typeof SharedGroupActivityView.Type;

export const SharedGroupHistoryInput = Schema.Struct({ ...Address, ...GroupHistoryFields });
export type SharedGroupHistoryInput = typeof SharedGroupHistoryInput.Type;
export const SharedGroupMessageChunkInput = Schema.Struct({
  ...Address,
  ...GroupMessageChunkFields,
});
export type SharedGroupMessageChunkInput = typeof SharedGroupMessageChunkInput.Type;
export const SharedGroupRunRespondInput = Schema.Struct({ ...Address, ...GroupRunRespondFields });
export type SharedGroupRunRespondInput = typeof SharedGroupRunRespondInput.Type;
export const SharedGroupRunAssetInput = Schema.Struct({ ...Address, ...GroupRunAssetFields });
export type SharedGroupRunAssetInput = typeof SharedGroupRunAssetInput.Type;
export const SharedGroupRunPageInput = Schema.Struct({ ...Address, ...GroupRunPageFields });
export type SharedGroupRunPageInput = typeof SharedGroupRunPageInput.Type;
export const SharedGroupRunItemInput = Schema.Struct({ ...Address, ...GroupRunItemFields });
export type SharedGroupRunItemInput = typeof SharedGroupRunItemInput.Type;
export const SharedGroupRunBodyInput = Schema.Struct({ ...Address, ...GroupRunBodyFields });
export type SharedGroupRunBodyInput = typeof SharedGroupRunBodyInput.Type;
export const SharedGroupPeerCall = Schema.Union([
  Schema.Struct({ type: Schema.Literal("capabilities") }),
  Schema.Struct({ type: Schema.Literal("runtime-response"), ...GroupRunRespondFields }),
  Schema.Struct({
    type: Schema.Literal("run-asset"),
    ...GroupRunAssetFields,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal("history"), ...GroupHistoryFields }),
  Schema.Struct({ type: Schema.Literal("message-chunk"), ...GroupMessageChunkFields }),
  Schema.Struct({ type: Schema.Literal("run-page"), ...GroupRunPageFields }),
  Schema.Struct({ type: Schema.Literal("run-item"), ...GroupRunItemFields }),
  Schema.Struct({ type: Schema.Literal("run-body-range"), ...GroupRunBodyFields }),
  Schema.Struct({ type: Schema.Literal("attachment-put"), chunk: GroupAttachmentChunk }),
  Schema.Struct({
    type: Schema.Literal("attachment-read"),
    attachmentId: Schema.String.check(Schema.isMaxLength(128)),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal("activity"), kind: ConversationActivityKind }),
  Schema.Struct({ type: Schema.Literal("activity-get") }),
  Schema.Struct({
    type: Schema.Literal("activity-watch"),
    after: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ type: Schema.Literal("get") }),
  Schema.Struct({
    type: Schema.Literal("send"),
    ...GroupPeerPayloadFields,
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
export const SharedGroupPeerResult = Schema.Union([
  GroupSnapshot,
  GroupPeerResponse,
  SharedGroupActivityView,
  GroupAttachmentChunk,
  GroupMessageChunk,
]);
export type SharedGroupPeerResult = typeof SharedGroupPeerResult.Type;
