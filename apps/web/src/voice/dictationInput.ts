import type { DesktopDictationCapability, DesktopDictationState } from "@t3tools/contracts";
import {
  VoiceInputController,
  throwIfVoiceTranscriptionAborted,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { DictationBackend } from "./dictationBackend";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createDictationInput(input: {
  readonly ownerKey: string;
  readonly backend: DictationBackend;
  readonly getCapability: () => DesktopDictationCapability;
  readonly createSessionId: () => string;
  readonly onTranscript: (text: string) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
}) {
  type Session = {
    readonly id: string;
    readonly started: ReturnType<typeof deferred<void>>;
    readonly finished: ReturnType<typeof deferred<string>>;
    readonly unsubscribe: () => void;
    limit: ReturnType<typeof setTimeout> | null;
    error: string | null;
  };
  let active: Session | null = null;
  let releasing: Promise<void> | null = null;
  const transcripts = new Map<string, Promise<string>>();
  const listeners = new Set<() => void>();
  let snapshot: VoiceInputState = { phase: "idle", error: null, errorAction: null };
  let live = true;
  const release = async () => {
    const session = active;
    if (!session) {
      if (releasing) await releasing;
      return;
    }
    active = null;
    if (session.limit) clearTimeout(session.limit);
    session.unsubscribe();
    session.started.reject(new Error("Dictation cancelled."));
    session.finished.reject(new Error("Dictation cancelled."));
    const completion = input.backend.stop(session.id, true).finally(() => {
      if (releasing === completion) releasing = null;
    });
    releasing = completion;
    await completion;
  };
  const controller = new VoiceInputController({
    recorder: {
      get uri() {
        return active?.id ?? null;
      },
      prepareToRecordAsync: async () => {
        const id = input.createSessionId();
        const started = deferred<void>();
        const finished = deferred<string>();
        void started.promise.catch(() => undefined);
        void finished.promise.catch(() => undefined);
        const unsubscribe = input.backend.subscribe(id, (state: DesktopDictationState) => {
          const session = active;
          if (!session || session.id !== state.sessionId) return;
          if (state.phase === "recording") started.resolve();
          if (state.phase === "finishing") void controller.stop();
          if (state.phase === "finished") {
            if (controller.currentState.phase === "preparing")
              started.reject(new Error("Microphone capture did not start."));
            finished.resolve(state.transcript);
            void controller.handleRecorderStatus({
              isFinished: true,
              hasError: false,
              error: null,
              url: id,
            });
          }
          if (state.phase === "error" || state.phase === "cancelled") {
            session.error = state.error ?? "Dictation cancelled.";
            const error = new Error(session.error);
            started.reject(error);
            finished.reject(error);
            void controller.interruptRecording(session.error);
          }
        });
        active = { id, started, finished, unsubscribe, limit: null, error: null };
        transcripts.set(id, finished.promise);
      },
      record: async ({ forDuration }) => {
        const session = active;
        if (!session) throw new Error("No dictation session.");
        await Promise.all([
          input.backend.start(session.id, input.getCapability().locale),
          session.started.promise,
        ]);
        if (active === session)
          session.limit = setTimeout(() => {
            void controller.stop();
          }, forDuration * 1_000);
      },
      stop: async () => {
        const session = active;
        if (!session) return;
        await input.backend.stop(session.id, false);
        await session.finished.promise;
      },
    },
    getTranscriber: () =>
      input.getCapability().available
        ? {
            prepare: async ({ signal }) => {
              throwIfVoiceTranscriptionAborted(signal);
              signal.addEventListener(
                "abort",
                () => {
                  void release().catch(() => undefined);
                },
                { once: true },
              );
              return {
                locale: input.getCapability().locale,
                transcribe: async (uri, options) => {
                  const result = transcripts.get(uri);
                  if (!result) throw new Error("Dictation is no longer available.");
                  const transcript = await result;
                  throwIfVoiceTranscriptionAborted(options.signal);
                  return transcript;
                },
              };
            },
          }
        : null,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: release,
    deleteRecording: (uri) => {
      transcripts.delete(uri);
    },
    readDraft: () =>
      live
        ? { ownerKey: input.ownerKey, text: "", selection: { start: 0, end: 0 }, revision: 0 }
        : null,
    commitDraft: (text) => {
      if (live) input.onTranscript(text);
    },
    onStateChange: (state) => {
      snapshot =
        state.phase === "error" && active?.error ? { ...state, error: active.error } : state;
      if (!live) return;
      input.onStateChange(snapshot);
      for (const listener of listeners) listener();
    },
  });
  return {
    controller,
    activate: () => {
      live = true;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      live = false;
      controller.dispose();
      listeners.clear();
      void release().catch(() => undefined);
    },
  };
}
