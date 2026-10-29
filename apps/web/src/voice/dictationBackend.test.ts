import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopDictationState } from "@t3tools/contracts";
import { createBrowserDictationBackend } from "./dictationBackend";

function setup() {
  const instances: Recognition[] = [];
  class Recognition {
    lang = "";
    continuous = false;
    interimResults = false;
    processLocally = false;
    onaudiostart: (() => void) | null = null;
    onaudioend: (() => void) | null = null;
    onresult:
      | ((event: {
          resultIndex: number;
          results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
        }) => void)
      | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  const backend = createBrowserDictationBackend(Recognition);
  const states: DesktopDictationState[] = [];
  const unsubscribe = backend.subscribe("one", (state) => states.push(state));
  return { backend, states, instances, unsubscribe };
}

describe("browser speech dictation", () => {
  it("waits for audio capture and publishes only final recognized words", async () => {
    const test = setup();
    await test.backend.start("one", "fr-FR");
    const engine = test.instances[0]!;
    expect(engine.start).toHaveBeenCalledOnce();
    expect(test.states).toEqual([]);
    expect(engine.processLocally).toBe(true);
    engine.onaudiostart?.();
    expect(test.states.map((state) => state.phase)).toEqual(["recording"]);
    engine.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: "Unfinished" } }],
    });
    engine.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "Écrire ces mots" } }],
    });
    engine.onaudioend?.();
    engine.onend?.();
    expect(test.states.map((state) => state.phase)).toEqual(["recording", "finishing", "finished"]);
    expect(test.states.at(-1)?.transcript).toBe("Écrire ces mots");
    test.unsubscribe();
    await test.backend.stop("one", true);
  });

  it("reports denied recognition honestly and ignores late results after abort", async () => {
    const test = setup();
    await test.backend.start("one", "en-US");
    const engine = test.instances[0]!;
    engine.onerror?.({ error: "service-not-allowed" });
    engine.onaudiostart?.();
    engine.onend?.();
    expect(test.states).toEqual([
      {
        sessionId: "one",
        phase: "error",
        transcript: "",
        error: "Allow microphone and speech recognition access in your browser.",
      },
    ]);
    expect(engine.abort).toHaveBeenCalledOnce();
    test.unsubscribe();
    await test.backend.stop("one", true);
  });
});
