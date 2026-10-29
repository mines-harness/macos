import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { GroupRunProjection } from "../../../../packages/contracts/src/groupTranscript.ts";
import {
  groupRunBodyRange,
  groupRunRuntimeRequest,
  projectGroupRun,
  projectGroupRunItem,
} from "./groupRunProjection.ts";

const at = DateTime.makeUnsafe("2026-10-29T00:00:00.000Z");
const encodeProjection = Schema.encodeSync(Schema.toCodecJson(GroupRunProjection));
const decodeProjection = Schema.decodeUnknownSync(Schema.toCodecJson(GroupRunProjection));
const target = {
  deliveryId: "delivery:one",
  memberId: "member:one",
  environmentId: EnvironmentId.make("environment:one"),
  threadId: ThreadId.make("thread:one"),
  runId: RunId.make("run:one"),
};
const item = (
  ordinal: number,
  overrides: Partial<OrchestrationV2TurnItem> = {},
): OrchestrationV2TurnItem =>
  ({
    id: TurnItemId.make(`item:${ordinal}`),
    threadId: target.threadId,
    runId: target.runId,
    nodeId: NodeId.make(`node:${ordinal}`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "assistant_message",
    messageId: MessageId.make(`message:${ordinal}`),
    text: `answer ${ordinal}`,
    streaming: false,
    ...overrides,
  }) as OrchestrationV2TurnItem;
const request = (id: string, nodeId: string): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make(nodeId),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: at,
  resolvedAt: null,
});

describe("group run projection", () => {
  it("only responds to a pending request explicitly attached to the selected run", () => {
    const pending = request("request:one", "node:1");
    const selected = item(1, {
      type: "user_input_request",
      requestId: pending.id,
      questions: [],
    });
    if (selected.type !== "user_input_request") throw new Error("Expected a question fixture");
    const find = (
      items: ReadonlyArray<OrchestrationV2TurnItem>,
      runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [pending],
    ) => groupRunRuntimeRequest(target, items, runtimeRequests, pending.id);

    expect(find([selected])).toBe(pending);
    expect(find([item(1)])).toBeNull();
    expect(find([{ ...selected, runId: RunId.make("private:run") }])).toBeNull();
    expect(find([{ ...selected, threadId: ThreadId.make("private:thread") }])).toBeNull();
    expect(find([{ ...selected, nodeId: NodeId.make("private:node") }])).toBeNull();
    expect(find([{ ...selected, requestId: RuntimeRequestId.make("private:request") }])).toBeNull();
    expect(find([selected], [{ ...pending, status: "resolved", resolvedAt: at }])).toBeNull();
    expect(
      find(
        [selected],
        [{ ...pending, responseCapability: { type: "not_resumable", reason: "Closed" } }],
      ),
    ).toBeNull();
    expect(find([selected], [])).toBeNull();
  });

  it("includes only the exact delivery run and its runtime requests", () => {
    const selected = item(1, {
      type: "user_input_request",
      requestId: RuntimeRequestId.make("request:one"),
      questions: [],
    });
    const inputItems = [
      selected,
      item(2, { runId: RunId.make("private:run") }),
      item(3, { threadId: ThreadId.make("private:thread") }),
      item(4, { runId: null }),
      item(5, { type: "user_message" }),
    ];
    const projection = projectGroupRun({
      ...target,
      items: inputItems,
      runtimeRequests: [
        request("request:one", "node:1"),
        request("private:request", "private:node"),
      ],
    });
    expect(projection.items.map((row) => row.id)).toEqual([selected.id]);
    expect(projection.runtimeRequests.map((row) => row.id)).toEqual(["request:one"]);
    expect(inputItems).toHaveLength(5);
  });

  it("pages each exact-run item once without returning private rows", () => {
    const items = Array.from({ length: 260 }, (_, index) => item(index));
    const newest = projectGroupRun({ ...target, items, runtimeRequests: [] });
    expect(newest.items.length).toBeLessThanOrEqual(128);
    expect(newest.hasMoreItems).toBe(true);
    expect(newest.beforeOrdinal).toBe(newest.items[0]!.ordinal);
    const collect = (beforeOrdinal?: number): OrchestrationV2TurnItem[] => {
      const page = projectGroupRun({
        ...target,
        items,
        runtimeRequests: [],
        ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
      });
      return [...(page.hasMoreItems ? collect(page.beforeOrdinal!) : []), ...page.items];
    };
    expect(collect().map((row) => row.id)).toEqual(items.map((row) => row.id));
  });

  it("bounds encoded multilingual message pages without losing body continuation", () => {
    const text = 'é🖤文字\\"\n'.repeat(20_000);
    const projection = projectGroupRun({
      ...target,
      items: [item(1, { text })],
      runtimeRequests: [],
    });
    const encoded = encodeProjection(projection);
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(32 * 1024);
    expect(decodeProjection(encoded)).toEqual(projection);
    expect(projection.items[0]).toMatchObject({
      bodyRange: {
        field: "text",
        totalBytes: Buffer.byteLength(text),
        endByte: Buffer.byteLength(text),
      },
    });
    expect("text" in projection.items[0]! && projection.items[0].text).not.toContain("�");
  });

  it("retains oversized nonbody rows as recoverable references and advances the cursor", () => {
    const huge = item(1, { type: "command_execution", input: "x".repeat(100_000) });
    const projection = projectGroupRun({ ...target, items: [item(0), huge], runtimeRequests: [] });
    expect(projection.deferredItems).toEqual([
      { id: huge.id, ordinal: 1, revision: DateTime.formatIso(at) },
    ]);
    expect(projection.items.map((row) => row.ordinal)).toEqual([0]);
    expect(projection.hasMoreItems).toBe(false);
    expect(projectGroupRunItem(target, huge).item).toMatchObject({
      id: huge.id,
      input: "x".repeat(100_000),
    });
  });

  it("retains response capabilities when oversized question content is deferred", () => {
    const pending = request("request:large-question", "node:1");
    const question = item(1, {
      type: "user_input_request",
      requestId: pending.id,
      questions: [
        { id: "question", header: "Confirm", question: "x".repeat(100_000), options: [] },
      ],
    });
    const projection = projectGroupRun({
      ...target,
      items: [question],
      runtimeRequests: [pending],
    });
    expect(projection.deferredItems.map((row) => row.id)).toEqual([question.id]);
    expect(projection.runtimeRequests).toEqual([pending]);
    expect(Buffer.byteLength(JSON.stringify(encodeProjection(projection)))).toBeLessThanOrEqual(
      32 * 1024,
    );
  });

  it("only materializes authorized run items and reconstructs original body bytes", () => {
    const text = "é🖤文字\n".repeat(15_000);
    const original = item(1, { text });
    const projection = projectGroupRun({ ...target, items: [original], runtimeRequests: [] });
    const bounded = projection.items[0]!;
    const range = bounded.bodyRange!;
    const earlier = groupRunBodyRange(target, original, {
      field: "text",
      before: range.startByte,
      revision: range.revision,
    })!;
    expect(Buffer.byteLength(earlier.text)).toBe(earlier.range.endByte - earlier.range.startByte);
    expect(earlier.range.endByte).toBe(range.startByte);
    const restore = (before: number): string => {
      if (before === 0) return "";
      const part = groupRunBodyRange(target, original, {
        field: "text",
        before,
        revision: range.revision,
      })!;
      return restore(part.range.startByte) + part.text;
    };
    expect(restore(range.startByte) + ("text" in bounded ? bounded.text : "")).toBe(text);
    expect(projectGroupRunItem(target, original).item).toEqual(original);
    expect(projectGroupRunItem(target, item(2, { runId: null })).item).toBeNull();
    expect(
      groupRunBodyRange(target, item(1, { text, runId: RunId.make("private:run") }), {
        field: "text",
        before: range.startByte,
        revision: range.revision,
      }),
    ).toBeNull();
    expect(
      groupRunBodyRange(target, original, {
        field: "text",
        before: range.startByte,
        revision: "stale",
      }),
    ).toBeNull();
  });
});
