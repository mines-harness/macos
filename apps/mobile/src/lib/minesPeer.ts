import { createBrowserPeer } from "@t3tools/client-runtime/peer";
import { RTCPeerConnection as NativePeerConnection } from "react-native-webrtc";

export const createMobilePeer: typeof createBrowserPeer = (input) =>
  createBrowserPeer({
    ...input,
    // Only the shared data-channel subset is used; native WebRTC omits browser media APIs.
    createConnection: (configuration) =>
      new NativePeerConnection({
        iceServers: configuration.iceServers?.map((server) => ({ urls: server.urls })),
        iceTransportPolicy: "all",
      }) as unknown as RTCPeerConnection,
  });
