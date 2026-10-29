// @effect-diagnostics globalTimers:off -- Native capture deadlines settle from speech callbacks outside Effect fibers.
import type { DesktopDictationState } from "@t3tools/contracts";
import { VOICE_RECORDING_LIMIT_SECONDS } from "@t3tools/client-runtime/voice-input";
import type { DictationDriver } from "./DesktopDictation.ts";

type Capture = {
  readonly sessionId: string;
  readonly publish: (state: DesktopDictationState) => void;
  readonly release: () => void;
  phase: DesktopDictationState["phase"];
  timeout: ReturnType<typeof setTimeout>;
};

export class DictationCapture {
  private active: Capture | null = null;
  private driver: DictationDriver | null = null;
  private readonly loadDriver: () => Promise<DictationDriver | null>;
  constructor(loadDriver: () => Promise<DictationDriver | null>) {
    this.loadDriver = loadDriver;
  }

  async start(
    sessionId: string,
    locale: string,
    publish: Capture["publish"],
    release: () => void,
  ): Promise<void> {
    if (this.active) throw new Error("Another dictation is already active.");
    const capture: Capture = {
      sessionId,
      publish,
      release,
      phase: "preparing",
      timeout: setTimeout(() => this.fail(capture, "The microphone did not become ready."), 30_000),
    };
    this.active = capture;
    publish({ sessionId, phase: "preparing", transcript: "", error: null });
    try {
      const driver = await this.loadDriver();
      if (this.active !== capture) return;
      if (!driver) throw new Error("Dictation is unavailable on this computer.");
      this.driver = driver;
      driver.start(sessionId, locale, (state) => {
        if (this.active !== capture || state.sessionId !== capture.sessionId) return;
        if (state.phase === "recording" && capture.phase !== "recording") {
          clearTimeout(capture.timeout);
          capture.timeout = setTimeout(
            () => this.stop(sessionId, false),
            VOICE_RECORDING_LIMIT_SECONDS * 1_000,
          );
        }
        capture.phase = state.phase;
        if (["finished", "cancelled", "error"].includes(state.phase)) this.release(capture);
        publish(state);
      });
    } catch {
      if (this.active === capture) this.fail(capture, "Could not start local dictation.");
    }
  }

  stop(sessionId: string, cancel: boolean): void {
    const capture = this.active;
    if (!capture || capture.sessionId !== sessionId) return;
    if (cancel || capture.phase === "preparing") {
      this.release(capture);
      capture.publish({ sessionId, phase: "cancelled", transcript: "", error: null });
      return;
    }
    if (capture.phase === "finishing") return;
    capture.phase = "finishing";
    clearTimeout(capture.timeout);
    capture.timeout = setTimeout(() => this.fail(capture, "Could not finish dictation."), 15_000);
    this.driver?.stop(false);
  }

  dispose(): void {
    const capture = this.active;
    if (capture) this.stop(capture.sessionId, true);
    this.driver?.dispose();
    this.driver = null;
  }

  private fail(capture: Capture, error: string): void {
    if (this.active !== capture) return;
    this.release(capture);
    capture.publish({ sessionId: capture.sessionId, phase: "error", transcript: "", error });
  }

  private release(capture: Capture): void {
    this.active = null;
    clearTimeout(capture.timeout);
    this.driver?.stop(true);
    capture.release();
  }
}
