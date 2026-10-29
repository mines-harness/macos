import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt, RunId, ThreadId, TurnItemId } from "./baseSchemas.ts";
import { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "./orchestrationV2.ts";

export const GroupRunProjection = Schema.Struct({
  canRespond: Schema.optionalKey(Schema.Boolean),
  deliveryId: Schema.String,
  memberId: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: RunId,
  items: Schema.Array(OrchestrationV2TurnItem).check(Schema.isMaxLength(128)),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  deferredItems: Schema.Array(
    Schema.Struct({ id: TurnItemId, ordinal: NonNegativeInt, revision: Schema.String }),
  ).check(Schema.isMaxLength(128)),
  hasMoreItems: Schema.Boolean,
  beforeOrdinal: Schema.NullOr(NonNegativeInt),
});
export type GroupRunProjection = typeof GroupRunProjection.Type;
