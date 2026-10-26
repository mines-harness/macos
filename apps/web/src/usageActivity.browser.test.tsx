import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../test/render";
import { useAppActivity, useTrackAppActivity } from "./usageActivity";

function ActivityValue({ session }: { session: boolean }) {
  const activity = useAppActivity();
  return <output>{session ? activity.sessionMs : activity.totalMs}</output>;
}

function Activity({
  enabled,
  session = false,
  show = true,
}: {
  enabled: boolean;
  session?: boolean;
  show?: boolean;
}) {
  useTrackAppActivity(enabled);
  return show ? <ActivityValue session={session} /> : null;
}

it("keeps this session separate from lifetime and continues when the usage view remounts", async () => {
  await using screen = await render(<Activity enabled={false} session />);
  using _timers = fakeTimers();
  vi.setSystemTime("2026-10-26T12:00:00.000Z");
  using focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using _visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.setItem(
    "mines:app-activity:v1",
    JSON.stringify({
      version: 1,
      trackedSince: "2026-10-26T00:00:00Z",
      days: { "2026-10-26": 60_000 },
    }),
  );
  await screen.rerender(<Activity enabled session />);
  const sessionBefore = Number(screen.container.textContent);
  await act(() => vi.advanceTimersByTime(30_000));
  expect(screen.container.textContent).toBe(String(sessionBefore + 30_000));
  await screen.rerender(<Activity enabled show={false} />);
  await act(() => vi.advanceTimersByTime(15_000));
  await screen.rerender(<Activity enabled session />);
  expect(screen.container.textContent).toBe(String(sessionBefore + 45_000));
  focus.mockReturnValue(false);
  await act(() => window.dispatchEvent(new Event("blur")));
  await act(() => vi.advanceTimersByTime(3_600_000));
  expect(screen.container.textContent).toBe(String(sessionBefore + 45_000));
  focus.mockReturnValue(true);
  await act(() => window.dispatchEvent(new Event("focus")));
  vi.setSystemTime("2026-10-26T20:00:00.000Z");
  await act(() => vi.advanceTimersByTime(15_000));
  expect(screen.container.textContent).toBe(String(sessionBefore + 75_000));
  await screen.rerender(<Activity enabled />);
  expect(screen.container.textContent).toBe("135000");
});

it("counts foreground time and resumes after browser page restoration", async () => {
  localStorage.removeItem("mines:app-activity:v1");
  await using screen = await render(<Activity enabled={false} />);
  using _timers = fakeTimers();
  vi.setSystemTime("2026-10-26T12:00:00.000Z");
  using focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using _visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await screen.rerender(<Activity enabled />);
  await act(() => vi.advanceTimersByTime(30_000));
  expect(screen.container.textContent).toBe("30000");
  focus.mockReturnValue(false);
  await act(() => window.dispatchEvent(new Event("blur")));
  await act(() => vi.advanceTimersByTime(3_600_000));
  expect(screen.container.textContent).toBe("30000");
  focus.mockReturnValue(true);
  await act(() => window.dispatchEvent(new Event("focus")));
  await act(() => window.dispatchEvent(new Event("pagehide")));
  await act(() => vi.advanceTimersByTime(60_000));
  await act(() => window.dispatchEvent(new Event("pageshow")));
  await act(() => vi.advanceTimersByTime(15_000));
  expect(screen.container.textContent).toBe("45000");
});

it("retains session time when storage writes fail and excludes suspended hours", async () => {
  localStorage.removeItem("mines:app-activity:v1");
  await using screen = await render(<Activity enabled={false} />);
  using _timers = fakeTimers();
  vi.setSystemTime("2026-10-26T12:00:00.000Z");
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  using _visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  using _storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await screen.rerender(<Activity enabled />);
  await act(() => vi.advanceTimersByTime(30_000));
  expect(screen.container.textContent).toBe("30000");
  vi.setSystemTime("2026-10-26T20:00:00.000Z");
  await act(() => vi.advanceTimersByTime(15_000));
  expect(screen.container.textContent).toBe("60000");
});
