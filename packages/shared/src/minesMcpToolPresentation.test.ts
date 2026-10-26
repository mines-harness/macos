import { describe, expect, it } from "vite-plus/test";

import {
  MINES_MCP_TOOL_NAMES,
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
    expect(resolveMinesMcpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a mine",
      logo: "mines",
    });
    expect(
      resolveMinesMcpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveMinesMcpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });
});
