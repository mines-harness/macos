import { describe, expect, it, vi } from "vite-plus/test";

import { createLiveVoicePeer } from "./liveVoicePeer";

function setup() {
  const microphone = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [microphone] } as unknown as MediaStream;
  const peer = Object.assign(new EventTarget(), {
    connectionState: "new",
    iceGatheringState: "complete",
    localDescription: null as RTCSessionDescriptionInit | null,
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "local-offer" })),
    setLocalDescription: vi.fn(async (offer: RTCSessionDescriptionInit) => {
      peer.localDescription = offer;
    }),
    setRemoteDescription: vi.fn(async (): Promise<void> => undefined),
    createDataChannel: vi.fn(() => ({ close: vi.fn() })),
    close: vi.fn(),
  });
  const output = { resume: vi.fn(async () => undefined), connect: vi.fn(), close: vi.fn() };
  let resolveMedia!: (stream: MediaStream) => void;
  const media = {
    promise: new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    }),
    resolve: (stream: MediaStream) => resolveMedia(stream),
  };
  const onConnected = vi.fn();
  const onFailure = vi.fn();
  const connection = createLiveVoicePeer({
    onConnected,
    onFailure,
    dependencies: {
      getUserMedia: () => media.promise,
      createConnection: () => peer as unknown as RTCPeerConnection,
      createOutput: () => output,
      createRemoteStream: () => stream,
      scheduleTimeout: (onTimeout, milliseconds) => {
        const timer = setTimeout(onTimeout, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  return { connection, media, stream, microphone, peer, output, onConnected, onFailure };
}

describe("live voice media lifecycle", () => {
  it("negotiates audio and stops every local resource on exit", async () => {
    const fixture = setup();
    fixture.media.resolve(fixture.stream);
    await expect(fixture.connection.offer).resolves.toBe("local-offer");
    expect(fixture.peer.addTrack).toHaveBeenCalledWith(fixture.microphone, fixture.stream);
    expect(fixture.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    await fixture.connection.acceptAnswer("provider-answer");
    expect(fixture.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "provider-answer",
    });
    fixture.peer.connectionState = "connected";
    fixture.peer.dispatchEvent(new Event("connectionstatechange"));
    expect(fixture.onConnected).toHaveBeenCalledOnce();
    fixture.connection.close();
    fixture.connection.close();
    expect(fixture.microphone.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.close).toHaveBeenCalledOnce();
    expect(fixture.output.close).toHaveBeenCalledOnce();
  });

  it("stops a late microphone grant after the user has already cancelled", async () => {
    const fixture = setup();
    fixture.connection.close();
    fixture.media.resolve(fixture.stream);
    await expect(fixture.connection.offer).rejects.toThrow("cancelled");
    expect(fixture.microphone.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.addTrack).not.toHaveBeenCalled();
  });

  it("ends media and reports failure instead of keeping a disconnected microphone open", async () => {
    const fixture = setup();
    fixture.media.resolve(fixture.stream);
    await fixture.connection.offer;
    fixture.peer.connectionState = "disconnected";
    fixture.peer.dispatchEvent(new Event("connectionstatechange"));
    expect(fixture.onFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(fixture.microphone.stop).toHaveBeenCalledOnce();
    expect(fixture.peer.close).toHaveBeenCalledOnce();
  });

  it("cleans up microphone tracks if negotiation fails", async () => {
    const fixture = setup();
    fixture.peer.createOffer.mockRejectedValueOnce(new Error("no offer"));
    fixture.media.resolve(fixture.stream);
    await expect(fixture.connection.offer).rejects.toThrow("no offer");
    expect(fixture.microphone.stop).toHaveBeenCalledOnce();
    expect(fixture.output.close).toHaveBeenCalledOnce();
  });

  it("applies a repeated SDP answer once while the first application is pending", async () => {
    const fixture = setup();
    fixture.media.resolve(fixture.stream);
    await fixture.connection.offer;
    let resolveAnswer!: () => void;
    fixture.peer.setRemoteDescription.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    const first = fixture.connection.acceptAnswer("provider-answer");
    const repeated = fixture.connection.acceptAnswer("provider-answer");
    const appliedCount = fixture.peer.setRemoteDescription.mock.calls.length;
    resolveAnswer();
    await Promise.all([first, repeated]);
    fixture.connection.close();
    expect(appliedCount).toBe(1);
  });
});
