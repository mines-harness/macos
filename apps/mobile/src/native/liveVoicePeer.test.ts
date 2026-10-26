import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  native: { WebRTCModule: {} as object | null },
  getUserMedia: vi.fn(),
  createConnection: vi.fn(),
}));
vi.mock("react-native", () => ({ NativeModules: mocks.native, Platform: { OS: "ios" } }));
vi.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: mocks.getUserMedia },
  RTCPeerConnection: vi.fn(function () {
    return mocks.createConnection();
  }),
  MediaStream: vi.fn(),
}));

import { createNativeLiveVoicePeer, isNativeLiveVoiceAvailable } from "./liveVoicePeer";

function setup() {
  mocks.native.WebRTCModule = {};
  mocks.getUserMedia.mockReset();
  mocks.createConnection.mockReset();
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], release: vi.fn() };
  const channel = { close: vi.fn() };
  const peer = Object.assign(new EventTarget(), {
    connectionState: "new",
    iceGatheringState: "complete",
    localDescription: null as { type: "offer"; sdp: string } | null,
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "native-offer" })),
    setLocalDescription: vi.fn(async (offer: { type: "offer"; sdp: string }) => {
      peer.localDescription = offer;
    }),
    setRemoteDescription: vi.fn(async () => undefined),
    createDataChannel: vi.fn(() => channel),
    close: vi.fn(),
  });
  mocks.createConnection.mockReturnValue(peer);
  mocks.getUserMedia.mockResolvedValue(stream);
  return { track, stream, peer, channel };
}

describe("native live voice", () => {
  it("uses audio-only native WebRTC and releases its native stream on exit", async () => {
    const fixture = setup();
    const connection = await createNativeLiveVoicePeer({
      onConnected: vi.fn(),
      onFailure: vi.fn(),
    });
    await expect(connection.offer).resolves.toBe("native-offer");
    expect(mocks.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(fixture.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    connection.close();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(fixture.stream.release).toHaveBeenCalledOnce();
    expect(fixture.channel.close).toHaveBeenCalledOnce();
    expect(fixture.peer.close).toHaveBeenCalledOnce();
  });

  it("releases native media granted after cancellation", async () => {
    const fixture = setup();
    let grant!: (stream: typeof fixture.stream) => void;
    mocks.getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const connection = await createNativeLiveVoicePeer({
      onConnected: vi.fn(),
      onFailure: vi.fn(),
    });
    connection.close();
    grant(fixture.stream);
    await expect(connection.offer).rejects.toThrow("cancelled");
    expect(fixture.stream.release).toHaveBeenCalledOnce();
    expect(fixture.peer.addTrack).not.toHaveBeenCalled();
  });

  it("does not offer live voice when its native transport is missing", async () => {
    setup();
    mocks.native.WebRTCModule = null;
    expect(isNativeLiveVoiceAvailable()).toBe(false);
    await expect(
      createNativeLiveVoicePeer({ onConnected: vi.fn(), onFailure: vi.fn() }),
    ).rejects.toThrow("updated native app");
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not request the microphone if cancelled while the native module loads", async () => {
    setup();
    const abort = new AbortController();
    const preparing = createNativeLiveVoicePeer({
      onConnected: vi.fn(),
      onFailure: vi.fn(),
      signal: abort.signal,
    });
    abort.abort();
    await expect(preparing).rejects.toThrow("cancelled");
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
  });
});
