import { PeerError, type PeerDescription } from "@t3tools/contracts/minesPeer";
import {
  createPeerSession,
  type PeerDataChannel,
  type PeerSession,
} from "@t3tools/shared/minesPeerTransport";
import { validateDirectDescription, validateStunServers } from "@t3tools/shared/minesPeerTrust";

export interface BrowserPeerEndpoint {
  readonly description: Promise<PeerDescription>;
  readonly session: Promise<PeerSession>;
  readonly acceptDescription: (description: PeerDescription) => Promise<void>;
  readonly close: () => void;
}

function adaptChannel(channel: RTCDataChannel): PeerDataChannel {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 16 * 1024;
  return {
    send: (data) => channel.send(data.slice().buffer),
    bufferedAmount: () => channel.bufferedAmount,
    onMessage: (listener) =>
      channel.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!(event.data instanceof ArrayBuffer)) {
          channel.close();
          return;
        }
        listener(new Uint8Array(event.data));
      }),
    onBufferedLow: (listener) => channel.addEventListener("bufferedamountlow", listener),
    onClose: (listener) => channel.addEventListener("close", listener),
    close: () => channel.close(),
  };
}

export function createBrowserPeer(input: {
  readonly remoteDeviceId: string;
  readonly initiator: boolean;
  readonly stunServers: ReadonlyArray<string>;
  readonly createConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
}): BrowserPeerEndpoint {
  const peer = (
    input.createConnection ?? ((configuration) => new RTCPeerConnection(configuration))
  )({
    iceServers: validateStunServers(input.stunServers).map((url) => ({ urls: url })),
    iceTransportPolicy: "all",
  });
  let control: RTCDataChannel | undefined;
  let bulk: RTCDataChannel | undefined;
  let ended = false;
  let settled = false;
  let opened: PeerSession | undefined;
  let resolveDescription!: (value: PeerDescription) => void;
  let rejectDescription!: (error: PeerError) => void;
  let resolveSession!: (value: PeerSession) => void;
  let rejectSession!: (error: PeerError) => void;
  const description = new Promise<PeerDescription>((resolve, reject) => {
    resolveDescription = resolve;
    rejectDescription = reject;
  });
  const session = new Promise<PeerSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  void description.catch(() => undefined);
  void session.catch(() => undefined);
  const close = () => {
    if (ended) return;
    ended = true;
    opened?.close();
    peer.close();
    rejectDescription(new PeerError({ code: "direct-unavailable" }));
    rejectSession(new PeerError({ code: "direct-unavailable" }));
  };
  const ready = async () => {
    if (ended || settled || control?.readyState !== "open" || bulk?.readyState !== "open") return;
    settled = true;
    try {
      const stats = await peer.getStats();
      let direct = false;
      stats.forEach((report) => {
        if (report.type !== "candidate-pair" || report.state !== "succeeded" || !report.nominated)
          return;
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        direct ||= [local?.candidateType, remote?.candidateType].every((type) =>
          ["host", "srflx", "prflx"].includes(type),
        );
      });
      if (!direct || ended) {
        close();
        return;
      }
      opened = createPeerSession(
        input.remoteDeviceId,
        adaptChannel(control),
        adaptChannel(bulk),
        close,
      );
      resolveSession(opened);
    } catch {
      close();
    }
  };
  const receiveChannel = (channel: RTCDataChannel) => {
    if (channel.label === "mines.control.v1" && control === undefined) control = channel;
    else if (channel.label === "mines.bulk.v1" && bulk === undefined) bulk = channel;
    else {
      close();
      return;
    }
    channel.addEventListener("open", () => {
      void ready();
    });
    channel.addEventListener("close", close);
    channel.addEventListener("error", close);
    void ready();
  };
  peer.addEventListener("datachannel", (event) => receiveChannel(event.channel));
  peer.addEventListener("connectionstatechange", () => {
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) close();
  });
  const gathered = () => {
    if (peer.iceGatheringState !== "complete") return;
    const value = peer.localDescription;
    if (!value || (value.type !== "offer" && value.type !== "answer")) {
      close();
      return;
    }
    const result = { type: value.type, sdp: value.sdp };
    try {
      validateDirectDescription(result);
      resolveDescription(result);
    } catch {
      close();
    }
  };
  peer.addEventListener("icegatheringstatechange", gathered);
  if (input.initiator) {
    receiveChannel(peer.createDataChannel("mines.control.v1", { ordered: true }));
    receiveChannel(peer.createDataChannel("mines.bulk.v1", { ordered: true }));
    void peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(gathered)
      .catch(close);
  }
  return {
    description,
    session,
    close,
    async acceptDescription(value) {
      validateDirectDescription(value);
      await peer.setRemoteDescription(value);
      if (value.type === "offer") {
        await peer.setLocalDescription(await peer.createAnswer());
        gathered();
      }
    },
  };
}
