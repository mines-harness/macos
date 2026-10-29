import { expect, it, vi } from "vite-plus/test";
import { createConversationActivityPublisher } from "./conversationActivityPublisher";

it("publishes recent editing without repeating every key and expires after input stops", () => {
  vi.useFakeTimers();
  try {
    const publish = vi.fn();
    using activity = createConversationActivityPublisher(publish);
    activity.onEdit();
    activity.onEdit();
    expect(publish.mock.calls).toEqual([["typing"]]);
    vi.advanceTimersByTime(3_000);
    activity.onEdit();
    vi.advanceTimersByTime(1_000);
    expect(publish.mock.calls).toEqual([["typing"], ["typing"]]);
    vi.advanceTimersByTime(3_000);
    expect(publish.mock.calls.at(-1)).toEqual(["idle"]);
    vi.advanceTimersByTime(20_000);
    expect(publish).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("advertises voice only after capture starts and clears it on stop, blur, and dispose", () => {
  vi.useFakeTimers();
  try {
    const publish = vi.fn();
    const activity = createConversationActivityPublisher(publish);
    activity.setCaptureActive(false);
    expect(publish).not.toHaveBeenCalled();
    activity.setCaptureActive(true);
    vi.advanceTimersByTime(4_000);
    expect(publish.mock.calls).toEqual([["voice"], ["voice"]]);
    activity.onBlur();
    expect(publish.mock.calls.at(-1)).toEqual(["idle"]);
    activity.onEdit();
    activity.onSubmit();
    expect(publish.mock.calls.slice(-2)).toEqual([["typing"], ["idle"]]);
    activity.setCaptureActive(true);
    activity[Symbol.dispose]();
    expect(publish.mock.calls.slice(-2)).toEqual([["voice"], ["idle"]]);
    const count = publish.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    expect(publish).toHaveBeenCalledTimes(count);
  } finally {
    vi.useRealTimers();
  }
});
