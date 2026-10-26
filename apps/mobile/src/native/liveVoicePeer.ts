import { createLiveVoicePeer, type LiveVoicePeer } from "@t3tools/client-runtime/voice-live";
import { NativeModules, Platform } from "react-native";

export function isNativeLiveVoiceAvailable(): boolean {
  return (
    (Platform.OS === "ios" || Platform.OS === "android") && Boolean(NativeModules.WebRTCModule)
  );
}

export async function createNativeLiveVoicePeer(input: {
  readonly onConnected: () => void;
  readonly onFailure: (error: Error) => void;
  readonly signal?: AbortSignal;
}): Promise<LiveVoicePeer> {
  if (!isNativeLiveVoiceAvailable()) throw new Error("Live voice requires an updated native app.");
  const rtc = await import("react-native-webrtc");
  if (input.signal?.aborted) throw new Error("Voice conversation cancelled.");
  let captured: InstanceType<typeof rtc.MediaStream> | null = null;
  let disposed = false;
  const media = createLiveVoicePeer({
    ...input,
    dependencies: {
      async getUserMedia() {
        captured = await rtc.mediaDevices.getUserMedia({ audio: true, video: false });
        if (disposed) captured.release();
        return captured as unknown as MediaStream;
      },
      createConnection: () => new rtc.RTCPeerConnection({}) as unknown as RTCPeerConnection,
      createRemoteStream: (track) =>
        new rtc.MediaStream([
          track as unknown as InstanceType<typeof rtc.MediaStreamTrack>,
        ]) as unknown as MediaStream,
      createOutput: () => ({
        resume: async () => undefined,
        // Native WebRTC routes received audio; releasing the peer owns its audio device lifecycle.
        connect: () => undefined,
        close() {
          disposed = true;
          captured?.release();
        },
      }),
      scheduleTimeout: (onTimeout, milliseconds) => {
        const timer = setTimeout(onTimeout, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  const onAbort = () => media.close();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    offer: media.offer,
    acceptAnswer: media.acceptAnswer,
    close() {
      input.signal?.removeEventListener("abort", onAbort);
      media.close();
    },
  };
}
