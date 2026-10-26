import { describe, expect, it } from "vite-plus/test";

import { summarizeMinesToolCalls, type MinesToolSummaryCall } from "./minesToolSummary.ts";

function completed(input: unknown, output?: unknown): MinesToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeMinesToolCalls", () => {
  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "mines_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeMinesToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 mine");
    expect(
      summarizeMinesToolCalls("thread-send", [
        completed({ toolName: "mines_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 mine");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: MinesToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeMinesToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 mine",
      failedCount: 2,
    });
    expect(summarizeMinesToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 mine",
      failedCount: 1,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeMinesToolCalls("delegate", [completed({}, failedChild), completed({}, failedChild)]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
    });
    expect(
      summarizeMinesToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeMinesToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 mine",
      failedCount: 0,
    });
  });
});
