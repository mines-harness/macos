import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";

describe("guest moderation permissions", () => {
  it.each([
    "thread.guest-share.close",
    "thread.guest-share.kick",
    "thread.guest-share.permission.set",
    "thread.guest-share.ban",
    "thread.guest-share.unban",
    "thread.guest-message.dismiss",
  ])("guards %s with the destination operate grant", (type) => {
    expect(clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, { type })).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("guards guest message sends without changing normal message sends", () => {
    expect(
      clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "message.dispatch",
        guestMessageId: "guest-message",
      }),
    ).toEqual([AuthOrchestrationOperateScope]);
    expect(
      clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "message.dispatch",
      }),
    ).toEqual([]);
  });

  it("provides an availability grant without changing other command guards", () => {
    expect(clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, undefined)).toEqual(
      [AuthOrchestrationOperateScope],
    );
    expect(
      clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "thread.archive",
      }),
    ).toEqual([]);
  });
});
