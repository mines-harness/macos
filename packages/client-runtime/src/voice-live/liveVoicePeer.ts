export interface VoiceAudioOutput {
  readonly resume: () => Promise<void>;
  readonly connect: (stream: MediaStream) => void;
  readonly close: () => void;
}

export interface LiveVoicePeerDependencies {
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly createConnection: () => RTCPeerConnection;
  readonly createOutput: () => VoiceAudioOutput;
  readonly createRemoteStream: (track: MediaStreamTrack) => MediaStream;
  readonly scheduleTimeout: (onTimeout: () => void, milliseconds: number) => () => void;
}

export interface LiveVoicePeer {
  readonly offer: Promise<string>;
  readonly acceptAnswer: (sdp: string) => Promise<void>;
  readonly close: () => void;
}

export function createLiveVoicePeer({
  onConnected,
  onFailure,
  dependencies,
}: {
  readonly onConnected: () => void;
  readonly onFailure: (error: Error) => void;
  readonly dependencies: LiveVoicePeerDependencies;
}): LiveVoicePeer {
  const peer = dependencies.createConnection();
  let output: VoiceAudioOutput;
  try {
    output = dependencies.createOutput();
  } catch (error) {
    peer.close();
    throw error;
  }
  let microphone: MediaStream | null = null;
  let events: RTCDataChannel | null = null;
  let closed = false;
  let answer: { readonly sdp: string; readonly applied: Promise<void> } | null = null;
  let cancelGathering: (() => void) | null = null;
  const ensureOpen = () => {
    if (closed) throw new Error("Voice conversation cancelled.");
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cancelGathering?.();
    microphone?.getTracks().forEach((track) => track.stop());
    events?.close();
    peer.close();
    output.close();
  };
  const fail = (message: string) => {
    if (closed) return;
    close();
    onFailure(new Error(message));
  };
  peer.addEventListener("connectionstatechange", () => {
    if (closed) return;
    if (peer.connectionState === "connected") onConnected();
    else if (["failed", "disconnected", "closed"].includes(peer.connectionState))
      fail("The voice connection ended. Start again to reconnect.");
  });
  peer.addEventListener("track", (event) => {
    if (closed || event.track.kind !== "audio") return;
    try {
      output.connect(event.streams[0] ?? dependencies.createRemoteStream(event.track));
    } catch {
      fail("Could not play the voice response.");
    }
  });
  let readyAudio: Promise<void>;
  let capture: Promise<MediaStream>;
  try {
    readyAudio = output.resume();
    capture = dependencies.getUserMedia();
  } catch (error) {
    close();
    throw error;
  }
  void readyAudio.catch(() => undefined);
  const offer = (async () => {
    try {
      microphone = await capture;
      if (closed) microphone.getTracks().forEach((track) => track.stop());
      ensureOpen();
      await readyAudio;
      ensureOpen();
      for (const track of microphone.getTracks()) {
        track.addEventListener("ended", () => fail("Microphone access ended."), { once: true });
        peer.addTrack(track, microphone);
      }
      events = peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      ensureOpen();
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            cancelTimeout();
            peer.removeEventListener("icegatheringstatechange", gathered);
            cancelGathering = null;
            if (error) reject(error);
            else resolve();
          };
          const gathered = () => {
            if (peer.iceGatheringState === "complete") finish();
          };
          const cancelTimeout = dependencies.scheduleTimeout(
            () => finish(new Error("The voice connection could not be prepared. Try again.")),
            25_000,
          );
          cancelGathering = () => finish(new Error("Voice conversation cancelled."));
          peer.addEventListener("icegatheringstatechange", gathered);
          gathered();
        });
      }
      ensureOpen();
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("The microphone connection did not produce an offer.");
      return sdp;
    } catch (error) {
      close();
      throw error;
    }
  })();
  return {
    offer,
    close,
    async acceptAnswer(sdp) {
      ensureOpen();
      if (answer) {
        if (answer.sdp !== sdp) throw new Error("The voice session changed. Start again.");
        return answer.applied;
      }
      const applied = peer.setRemoteDescription({ type: "answer", sdp });
      answer = { sdp, applied };
      return applied;
    },
  };
}
