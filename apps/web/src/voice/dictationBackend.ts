import type {
  DesktopBridge,
  DesktopDictationCapability,
  DesktopDictationState,
} from "@t3tools/contracts";

export interface DictationBackend {
  capability(locale: string): Promise<DesktopDictationCapability>;
  subscribe(sessionId: string, listener: (state: DesktopDictationState) => void): () => void;
  start(sessionId: string, locale: string): Promise<void>;
  stop(sessionId: string, cancel: boolean): Promise<void>;
}

type RecognitionResult = { readonly isFinal: boolean; readonly 0: { readonly transcript: string } };
interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => BrowserRecognition;

export function createBrowserDictationBackend(
  Constructor: RecognitionConstructor,
): DictationBackend {
  let listener: ((state: DesktopDictationState) => void) | null = null;
  let active: {
    sessionId: string;
    recognition: BrowserRecognition;
    terminal: boolean;
    stopping: boolean;
  } | null = null;
  return {
    capability: async (locale) => ({
      available: true,
      locale,
      reason: "Uses your browser’s speech service. Audio processing depends on your browser.",
    }),
    subscribe: (sessionId, callback) => {
      const scoped = (state: DesktopDictationState) => {
        if (state.sessionId === sessionId) callback(state);
      };
      listener = scoped;
      return () => {
        if (listener === scoped) listener = null;
      };
    },
    start: async (sessionId, locale) => {
      const recognition = new Constructor();
      const session = { sessionId, recognition, terminal: false, stopping: false };
      const results = new Map<number, string>();
      active?.recognition.abort();
      active = session;
      recognition.lang = locale;
      recognition.continuous = true;
      recognition.interimResults = false;
      if ("processLocally" in recognition) recognition.processLocally = true;
      const publish = (
        phase: DesktopDictationState["phase"],
        transcript = "",
        error: string | null = null,
      ) => {
        if (active !== session || session.terminal) return;
        if (["finished", "cancelled", "error"].includes(phase)) session.terminal = true;
        listener?.({ sessionId, phase, transcript, error });
      };
      recognition.onaudiostart = () => publish("recording");
      recognition.onaudioend = () => publish("finishing");
      recognition.onresult = ({ resultIndex, results: incoming }) => {
        for (let index = resultIndex; index < incoming.length; index += 1) {
          const result = incoming[index];
          if (result?.isFinal) results.set(index, result[0].transcript);
        }
      };
      recognition.onerror = ({ error }) => {
        publish(
          "error",
          "",
          error === "not-allowed" || error === "service-not-allowed"
            ? "Allow microphone and speech recognition access in your browser."
            : error === "language-not-supported"
              ? "This speech language is not installed in your browser."
              : "Speech recognition is unavailable in this browser. Try the desktop app.",
        );
        recognition.abort();
      };
      recognition.onend = () =>
        publish(
          "finished",
          [...results.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, text]) => text)
            .join(" "),
        );
      try {
        recognition.start();
      } catch {
        active = null;
        recognition.abort();
        throw new Error("Could not start browser speech recognition.");
      }
    },
    stop: async (sessionId, cancel) => {
      if (!active || active.sessionId !== sessionId) return;
      if (cancel) {
        active.terminal = true;
        active.recognition.abort();
        active = null;
      } else if (!active.stopping && !active.terminal) {
        active.stopping = true;
        active.recognition.stop();
      }
    },
  };
}

export function createDictationBackend(
  bridge: DesktopBridge | undefined,
  scope: Window,
): DictationBackend | null {
  if (
    bridge?.getDictationCapability &&
    bridge.startDictation &&
    bridge.stopDictation &&
    bridge.onDictationState
  ) {
    const { getDictationCapability, startDictation, stopDictation, onDictationState } = bridge;
    return {
      capability: getDictationCapability,
      subscribe: (sessionId, listener) =>
        onDictationState((state) => {
          if (state.sessionId === sessionId) listener(state);
        }),
      start: (sessionId, locale) => startDictation({ sessionId, locale }),
      stop: (sessionId, cancel) => stopDictation({ sessionId, cancel }),
    };
  }
  const browser = scope as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return Constructor && scope.isSecureContext ? createBrowserDictationBackend(Constructor) : null;
}
