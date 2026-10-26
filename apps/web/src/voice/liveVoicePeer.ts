import {
  createLiveVoicePeer as createPeer,
  type LiveVoicePeerDependencies,
  type VoiceAudioOutput,
} from "@t3tools/client-runtime/voice-live";

export type { LiveVoicePeer } from "@t3tools/client-runtime/voice-live";

function createOutput(): VoiceAudioOutput {
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode | null = null;
  return {
    resume: () => context.resume(),
    connect(stream) {
      source?.disconnect();
      source = context.createMediaStreamSource(stream);
      source.connect(context.destination);
    },
    close() {
      source?.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}

export function liveVoiceUnavailableReason(): string | null {
  if (!globalThis.isSecureContext)
    return "Voice requires a secure connection (HTTPS or localhost).";
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return "Microphone access is unavailable.";
  if (typeof RTCPeerConnection === "undefined" || typeof AudioContext === "undefined")
    return "Live voice is unavailable in this browser.";
  return null;
}

export function createLiveVoicePeer(input: {
  readonly onConnected: () => void;
  readonly onFailure: (error: Error) => void;
  readonly dependencies?: LiveVoicePeerDependencies;
}) {
  return createPeer({
    ...input,
    dependencies: input.dependencies ?? {
      getUserMedia: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        }),
      createConnection: () => new RTCPeerConnection(),
      createOutput,
      createRemoteStream: (track) => new MediaStream([track]),
      scheduleTimeout: (onTimeout, milliseconds) => {
        const timer = setTimeout(onTimeout, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
}
