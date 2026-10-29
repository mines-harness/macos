import { describe, expect, it, vi } from "vite-plus/test";

import { createConversationActivityPublisher } from "./conversationActivityPublisher";

const restoreTimers = () => ({ [Symbol.dispose]: () => vi.useRealTimers() });

describe("conversation activity publishing", () => {
  it("throttles typing leases and stops after the user pauses with a draft still present", async () => {
    vi.useFakeTimers();
    using _timers = restoreTimers();
    const publish = vi.fn();
    using activity = createConversationActivityPublisher(publish);
    activity.typing();
    activity.typing();
    expect(publish.mock.calls).toEqual([["typing"]]);
    await vi.advanceTimersByTimeAsync(2_000);
    activity.typing();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(publish.mock.calls).toEqual([["typing"], ["typing"]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(publish.mock.calls).toEqual([["typing"], ["typing"], ["idle"]]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("prioritizes actual voice capture, renews it, and clears it on stop", async () => {
    vi.useFakeTimers();
    using _timers = restoreTimers();
    const publish = vi.fn();
    using activity = createConversationActivityPublisher(publish);
    activity.voice(true);
    activity.typing();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(publish.mock.calls).toEqual([["voice"], ["voice"], ["voice"]]);
    activity.voice(false);
    expect(publish).toHaveBeenLastCalledWith("idle");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it("clears on submit or disposal and never renews a disposed conversation", async () => {
    vi.useFakeTimers();
    using _timers = restoreTimers();
    const publish = vi.fn();
    const activity = createConversationActivityPublisher(publish);
    activity.typing();
    activity.clear();
    activity.clear();
    activity.voice(true);
    activity[Symbol.dispose]();
    activity.typing();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(publish.mock.calls).toEqual([["typing"], ["idle"], ["voice"], ["idle"]]);
  });
});
