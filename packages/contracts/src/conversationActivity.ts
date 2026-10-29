import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

export const CONVERSATION_ACTIVITY_TTL_MS = 8_000;

export const ConversationActivityKind = Schema.Literals(["idle", "typing", "voice"]);
export type ConversationActivityKind = typeof ConversationActivityKind.Type;

export const ConversationActivity = Schema.Struct({
  kind: ConversationActivityKind,
  expiresAt: IsoDateTime,
});
export type ConversationActivity = typeof ConversationActivity.Type;

export const activeConversationActivity = (
  activity: ConversationActivity | null | undefined,
  now: number,
): ConversationActivityKind =>
  activity && Date.parse(activity.expiresAt) > now ? activity.kind : "idle";
