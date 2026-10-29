import { describe, expect, it } from "vite-plus/test";
import { resolvePendingTaskInteractionMode } from "./plan-mode";

describe("plan mode availability", () => {
  it("preserves a pending plan despite the retired false preference", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: false,
        draftInteractionMode: "plan",
        provider: { showInteractionModeToggle: true },
      }),
    ).toBe("plan");
  });
  it("respects provider capability", () => {
    expect(
      resolvePendingTaskInteractionMode({
        planModeEnabled: true,
        draftInteractionMode: "plan",
        provider: { showInteractionModeToggle: false },
      }),
    ).toBe("default");
  });
});
