import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopDictationState } from "@t3tools/contracts";
import type { DictationDriver } from "./DesktopDictation.ts";
import { DictationCapture } from "./DictationCapture.ts";

function setup() {
  let emit: (state: DesktopDictationState) => void = () => undefined;
  const driver: DictationDriver = {
    capability: async (locale) => ({ available: true, locale, reason: null }),
    start: vi.fn((_id, _locale, publish) => {
      emit = publish;
    }),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  const capture = new DictationCapture(async () => driver);
  const states: DesktopDictationState[] = [];
  const release = vi.fn();
  return {
    driver,
    capture,
    states,
    release,
    start: () => capture.start("one", "en-US", (state) => states.push(state), release),
    emit: (phase: DesktopDictationState["phase"], sessionId = "one", transcript = "") =>
      emit({ sessionId, phase, transcript, error: null }),
  };
}

describe("desktop dictation capture", () => {
  it("starts as preparing, trusts only its session, and releases terminal capture", async () => {
    const test = setup();
    await test.start();
    expect(test.states.map((state) => state.phase)).toEqual(["preparing"]);
    test.emit("recording", "another-session");
    expect(test.states).toHaveLength(1);
    test.emit("recording");
    test.emit("finished", "one", "A transcript");
    expect(test.states.map((state) => state.phase)).toEqual(["preparing", "recording", "finished"]);
    expect(test.release).toHaveBeenCalledOnce();
    expect(test.driver.stop).toHaveBeenCalledWith(true);
    test.capture.dispose();
  });

  it("rejects concurrent capture and stops its own microphone on disposal", async () => {
    const test = setup();
    await test.start();
    await expect(
      test.capture.start(
        "two",
        "en-US",
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("already active");
    test.capture.dispose();
    test.emit("recording");
    expect(test.states.map((state) => state.phase)).toEqual(["preparing", "cancelled"]);
    expect(test.driver.stop).toHaveBeenCalledWith(true);
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("does not start the microphone when disposed during native preparation", async () => {
    let complete!: (driver: DictationDriver) => void;
    const pending = new Promise<DictationDriver>((resolve) => {
      complete = resolve;
    });
    const test = setup();
    const capture = new DictationCapture(() => pending);
    const start = capture.start("one", "en-US", () => undefined, test.release);
    capture.dispose();
    complete(test.driver);
    await start;
    expect(test.driver.start).not.toHaveBeenCalled();
    expect(test.release).toHaveBeenCalledOnce();
  });
});
