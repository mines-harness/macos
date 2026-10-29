import { describe, expect, it } from "vite-plus/test";
import type { DesktopDictationState } from "@t3tools/contracts";
import type { DictationBackend } from "./dictationBackend";
import { createDictationInput } from "./dictationInput";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  const requested = deferred();
  const stopping = deferred();
  const released = deferred();
  let listener: ((state: DesktopDictationState) => void) | null = null;
  const stops: boolean[] = [];
  const transcripts: string[] = [];
  const phases: string[] = [];
  const backend: DictationBackend = {
    capability: async (locale) => ({ available: true, locale, reason: null }),
    subscribe: (_id, next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    start: async () => {
      requested.resolve();
    },
    stop: async (_id, cancel) => {
      stops.push(cancel);
      if (cancel) released.resolve();
      else stopping.resolve();
    },
  };
  const capture = createDictationInput({
    ownerKey: "group:one",
    backend,
    getCapability: () => ({ available: true, locale: "en-US", reason: null }),
    createSessionId: () => "dictation-one",
    onTranscript: (text) => transcripts.push(text),
    onStateChange: (state) => phases.push(state.phase),
  });
  return {
    ...capture,
    requested,
    stopping,
    released,
    stops,
    transcripts,
    phases,
    emit: (phase: DesktopDictationState["phase"], transcript = "", error: string | null = null) =>
      listener?.({ sessionId: "dictation-one", phase, transcript, error }),
  };
}

describe("composer dictation", () => {
  it("waits for actual capture and inserts the transcript only after finishing", async () => {
    const session = setup();
    const start = session.controller.start();
    await session.requested.promise;
    expect(session.controller.currentState.phase).toBe("preparing");
    session.emit("recording");
    await start;
    expect(session.controller.currentState.phase).toBe("recording");
    expect(session.transcripts).toEqual([]);
    const finish = session.controller.stop();
    await session.stopping.promise;
    expect(session.controller.currentState.phase).toBe("transcribing");
    session.emit("finished", "Add these words");
    await finish;
    expect(session.transcripts).toEqual(["Add these words"]);
    expect(session.controller.currentState.phase).toBe("idle");
    expect(session.stops).toEqual([false, true]);
    session.dispose();
  });

  it("cancels pending microphone permission without starting capture later", async () => {
    const session = setup();
    const start = session.controller.start();
    await session.requested.promise;
    session.controller.cancel();
    await session.released.promise;
    session.emit("recording");
    session.emit("finished", "Discard me");
    await start;
    expect(session.stops).toEqual([true]);
    expect(session.phases).not.toContain("recording");
    expect(session.transcripts).toEqual([]);
    expect(session.controller.currentState.phase).toBe("idle");
    session.dispose();
  });

  it("discards recording and late results when the composer unmounts", async () => {
    const session = setup();
    const start = session.controller.start();
    await session.requested.promise;
    session.emit("recording");
    await start;
    session.dispose();
    await session.released.promise;
    session.emit("finished", "Do not append to another group");
    expect(session.transcripts).toEqual([]);
    expect(session.controller.currentState.phase).toBe("idle");
    expect(session.stops).toEqual([true]);
  });

  it("clears recording on a native error and discards its transcript", async () => {
    const session = setup();
    const start = session.controller.start();
    await session.requested.promise;
    session.emit("recording");
    await start;
    session.emit("error", "", "Microphone disconnected");
    await session.released.promise;
    expect(session.controller.currentState.phase).toBe("error");
    expect(session.transcripts).toEqual([]);
    expect(session.stops).toEqual([true]);
    session.dispose();
  });
});
