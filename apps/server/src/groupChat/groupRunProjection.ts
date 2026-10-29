import {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  type OrchestrationV2BodyRange,
  type OrchestrationV2BodyRangeResult,
  type OrchestrationV2GetTurnItemResult,
  type EnvironmentId,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import type { GroupRunProjection } from "../../../../packages/contracts/src/groupTranscript.ts";
import {
  projectTurnItemForDetail,
  projectTurnItemForWire,
} from "../orchestration-v2/WireProjection.ts";
import { bodyWindow, earlierBodyWindow } from "../orchestration-v2/threadBodyRanges.ts";

const MAX_ITEMS = 128;
const MAX_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 8 * 1024;
const encodeItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
const encodeRequest = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2RuntimeRequest));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

interface GroupRunTarget {
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface GroupRunProjectionInput {
  readonly deliveryId: string;
  readonly memberId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly beforeOrdinal?: number;
}

export function projectGroupRun(input: GroupRunProjectionInput): GroupRunProjection {
  const output = {
    deliveryId: input.deliveryId,
    memberId: input.memberId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    runId: input.runId,
    items: [] as OrchestrationV2TurnItem[],
    runtimeRequests: [] as OrchestrationV2RuntimeRequest[],
    deferredItems: [] as Array<GroupRunProjection["deferredItems"][number]>,
    hasMoreItems: false,
    beforeOrdinal: null as number | null,
  };
  const candidates = input.items
    .filter((item) => belongsToRun(input, item) && item.ordinal < (input.beforeOrdinal ?? Infinity))
    .toSorted((a, b) => b.ordinal - a.ordinal);
  const requestIds = new Set<string>();
  const requestMetadata = input.runtimeRequests.map(
    ({ answers: _answers, feedback: _feedback, ...request }) => ({
      ...request,
      nativeRequestRef: null,
    }),
  );
  const requestById = new Map(requestMetadata.map((request) => [request.id, request]));
  const requestsByNode = new Map<string, OrchestrationV2RuntimeRequest[]>();
  for (const request of requestMetadata) {
    const existing = requestsByNode.get(request.nodeId);
    if (existing === undefined) requestsByNode.set(request.nodeId, [request]);
    else existing.push(request);
  }
  const requestSizes = new Map<string, number>();
  const emptyBytes = bytes(output) + 64;
  let usedBytes = emptyBytes;
  let index = 0;
  for (; index < Math.min(candidates.length, MAX_ITEMS); index += 1) {
    const source = candidates[index]!;
    const explicitRequest = "requestId" in source ? requestById.get(source.requestId) : undefined;
    const requests = (
      "requestId" in source
        ? explicitRequest === undefined
          ? []
          : [explicitRequest]
        : source.nodeId === null
          ? []
          : (requestsByNode.get(source.nodeId) ?? [])
    ).filter((request) => request.nodeId === source.nodeId && !requestIds.has(request.id));
    const requestBytes = requests.reduce((size, request) => {
      const length = requestSizes.get(request.id) ?? bytes(encodeRequest(request)) + 1;
      requestSizes.set(request.id, length);
      return size + length;
    }, 0);
    let projected = shortenBody(projectTurnItemForWire(source), MAX_BODY_BYTES);
    let itemBytes = bytes(encodeItem(projected)) + 1;
    for (
      let limit = MAX_BODY_BYTES / 2;
      itemBytes + requestBytes + emptyBytes > MAX_BYTES && limit >= 0;
      limit = limit === 0 ? -1 : Math.floor(limit / 2)
    ) {
      const shortened = shortenBody(projected, limit);
      if (shortened === projected) break;
      projected = shortened;
      itemBytes = bytes(encodeItem(projected)) + 1;
    }
    if (itemBytes + requestBytes + emptyBytes > MAX_BYTES) {
      const reference = {
        id: source.id,
        ordinal: source.ordinal,
        revision: turnItemDetailRevision(source),
      };
      const referenceBytes = bytes(reference) + requestBytes + 1;
      if (usedBytes + referenceBytes > MAX_BYTES) break;
      output.deferredItems.push(reference);
      output.runtimeRequests.push(...requests);
      for (const request of requests) requestIds.add(request.id);
      usedBytes += referenceBytes;
    } else {
      if (usedBytes + itemBytes + requestBytes > MAX_BYTES) break;
      output.items.push(projected);
      output.runtimeRequests.push(...requests);
      for (const request of requests) requestIds.add(request.id);
      usedBytes += itemBytes + requestBytes;
    }
  }
  output.items.reverse();
  output.deferredItems.reverse();
  output.hasMoreItems = index < candidates.length;
  output.beforeOrdinal = output.hasMoreItems && index > 0 ? candidates[index - 1]!.ordinal : null;
  return output;
}

function belongsToRun(target: GroupRunTarget, item: OrchestrationV2TurnItem): boolean {
  return (
    item.threadId === target.threadId && item.runId === target.runId && item.type !== "user_message"
  );
}

export function groupRunRuntimeRequest(
  target: GroupRunTarget,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
  requestId: RuntimeRequestId,
): OrchestrationV2RuntimeRequest | null {
  const request = requests.find((candidate) => candidate.id === requestId);
  if (
    request === undefined ||
    request.status !== "pending" ||
    request.responseCapability.type === "not_resumable"
  ) {
    return null;
  }
  return items.some(
    (item) =>
      belongsToRun(target, item) &&
      item.nodeId === request.nodeId &&
      "requestId" in item &&
      item.requestId === requestId,
  )
    ? request
    : null;
}

function shortenBody(item: OrchestrationV2TurnItem, limit: number): OrchestrationV2TurnItem {
  const field = item.type === "proposed_plan" ? "markdown" : "text" in item ? "text" : null;
  if (field === null) return item;
  const text =
    field === "markdown" && "markdown" in item ? item.markdown : "text" in item ? item.text : "";
  const body = Buffer.from(text, "utf8");
  if (body.length <= limit) return item;
  const range = item.bodyRange ?? bodyWindow(text, field).range;
  let start = Math.max(0, body.length - limit);
  while (start < body.length && (body[start]! & 0xc0) === 0x80) start += 1;
  return {
    ...item,
    [field]: body.subarray(start).toString("utf8"),
    bodyRange: { ...range, startByte: range.endByte - body.length + start },
  };
}

export function projectGroupRunItem(
  target: GroupRunTarget,
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2GetTurnItemResult {
  return {
    item: item !== null && belongsToRun(target, item) ? projectTurnItemForDetail(item) : null,
  };
}

export function groupRunBodyRange(
  target: GroupRunTarget,
  item: OrchestrationV2TurnItem | null,
  request: {
    readonly field: OrchestrationV2BodyRange["field"];
    readonly before: number;
    readonly revision: string;
  },
): OrchestrationV2BodyRangeResult | null {
  if (item === null || !belongsToRun(target, item)) return null;
  const text =
    request.field === "text" && "text" in item
      ? item.text
      : request.field === "markdown" && "markdown" in item
        ? item.markdown
        : undefined;
  if (text === undefined || item.bodyRange !== undefined) return null;
  return earlierBodyWindow(text, request.field, request.before, request.revision);
}
