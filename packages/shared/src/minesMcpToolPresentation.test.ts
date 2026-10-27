import { describe, expect, it } from "vite-plus/test";

import {
  MINES_MCP_TOOL_NAMES,
  resolveMinesMcpSummaryAction,
  resolveMinesMcpToolDefinition,
  resolveMinesMcpToolPresentation,
} from "./minesMcpToolPresentation.ts";

describe("resolveMinesMcpToolPresentation", () => {
  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of MINES_MCP_TOOL_NAMES) {
      const presentation = resolveMinesMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__mines__",
        "mines.",
        "mines:",
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveMinesMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveMinesMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveMinesMcpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveMinesMcpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});

describe("resolveMinesMcpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveMinesMcpToolDefinition("mcp__t3-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveMinesMcpToolDefinition("preview_type")?.labels);
    expect(
      resolveMinesMcpToolDefinition("t3_thread_transfer", { action: "fork" })?.displayName,
    ).toBe(resolveMinesMcpToolDefinition("t3_thread_fork")?.displayName);
    expect(resolveMinesMcpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveMinesMcpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveMinesMcpSummaryAction("mcp__t3-code__t3_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveMinesMcpSummaryAction("t3_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveMinesMcpSummaryAction("t3_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveMinesMcpSummaryAction("t3_thread_configure", {})).toBe("thread-configuration");
    expect(resolveMinesMcpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveMinesMcpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
