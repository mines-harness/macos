import * as NodeModule from "node:module";
import { PeerError, type PeerDescription, type PeerChannel } from "@t3tools/contracts/minesPeer";
import {
  createPeerSession,
  type PeerDataChannel,
  type PeerSession,
} from "@t3tools/shared/minesPeerTransport";
import {
  isDirectCandidatePair,
  validateDirectDescription,
  validateStunServers,
} from "@t3tools/shared/minesPeerTrust";
import type { DataChannel } from "node-datachannel";

const requireNative = NodeModule.createRequire(import.meta.url);

export interface NodePeerEndpoint {
  readonly description: Promise<PeerDescription>;
  readonly session: Promise<PeerSession>;
  readonly acceptDescription: (description: PeerDescription) => void;
  readonly activateCandidates: () => void;
  readonly close: () => void;
}

function adaptChannel(channel: DataChannel): PeerDataChannel {
  channel.setBufferedAmountLowThreshold(16 * 1024);
  return {
    send: (data) => {
      if (!channel.sendMessageBinary(data)) throw new PeerError({ code: "closed" });
    },
    bufferedAmount: () => channel.bufferedAmount(),
    onMessage: (listener) =>
      channel.onMessage((value) => {
        if (typeof value === "string") {
          channel.close();
          return;
        }
        listener(new Uint8Array(value));
      }),
    onBufferedLow: (listener) => channel.onBufferedAmountLow(listener),
    onClose: (listener) => channel.onClosed(listener),
    close: () => channel.close(),
  };
}

export function createNodePeer(input: {
  readonly remoteDeviceId: string;
  readonly initiator: boolean;
  readonly stunServers: ReadonlyArray<string>;
  readonly allowedChannels?: ReadonlyArray<PeerChannel>;
}): NodePeerEndpoint {
  const { PeerConnection } = requireNative("node-datachannel") as typeof import("node-datachannel");
  const peer = new PeerConnection("mines", {
    iceServers: validateStunServers(input.stunServers),
    maxMessageSize: 65_537,
    disableFingerprintVerification: false,
  });
  let control: DataChannel | undefined;
  let bulk: DataChannel | undefined;
  let expectedFingerprint: string | undefined;
  let heldCandidates: Array<{ candidate: string; mid: string }> = [];
  let settled = false;
  let ended = false;
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
  // Both promises are exposed immediately; either may reject before its caller starts awaiting it.
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
  const ready = () => {
    if (ended || settled || !control?.isOpen() || !bulk?.isOpen()) return;
    const fingerprint = peer.remoteFingerprint();
    if (
      !expectedFingerprint ||
      fingerprint.algorithm !== "sha-256" ||
      fingerprint.value.toUpperCase() !== expectedFingerprint ||
      !isDirectCandidatePair(peer.getSelectedCandidatePair())
    ) {
      close();
      return;
    }
    settled = true;
    opened = createPeerSession(
      input.remoteDeviceId,
      adaptChannel(control),
      adaptChannel(bulk),
      close,
      input.allowedChannels,
    );
    resolveSession(opened);
  };
  const receiveChannel = (channel: DataChannel) => {
    if (channel.getLabel() === "mines.control.v1" && control === undefined) control = channel;
    else if (channel.getLabel() === "mines.bulk.v1" && bulk === undefined) bulk = channel;
    else {
      close();
      return;
    }
    channel.onOpen(ready);
    channel.onClosed(close);
    channel.onError(close);
    ready();
  };
  peer.onDataChannel(receiveChannel);
  peer.onStateChange((state) => {
    if (state === "failed" || state === "closed" || state === "disconnected") close();
  });
  peer.onGatheringStateChange((state) => {
    if (state !== "complete") return;
    const value = peer.localDescription();
    if (!value || (value.type !== "offer" && value.type !== "answer")) {
      close();
      return;
    }
    try {
      const result = { type: value.type, sdp: value.sdp };
      validateDirectDescription(result);
      resolveDescription(result);
    } catch {
      close();
    }
  });
  if (input.initiator) {
    receiveChannel(peer.createDataChannel("mines.control.v1"));
    receiveChannel(peer.createDataChannel("mines.bulk.v1"));
  }
  return {
    description,
    session,
    close,
    activateCandidates() {
      if (ended) throw new PeerError({ code: "closed" });
      const candidates = heldCandidates;
      heldCandidates = [];
      for (const candidate of candidates)
        peer.addRemoteCandidate(candidate.candidate, candidate.mid);
    },
    acceptDescription(value) {
      expectedFingerprint = validateDirectDescription(value);
      if (value.type !== "offer") {
        peer.setRemoteDescription(value.sdp, value.type);
        return;
      }
      // libdatachannel 0.24.5 can start DTLS before the initiator commits the answer fingerprint; wait for its signed acknowledgement.
      let mid = "0";
      const lines = value.sdp.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith("a=mid:")) mid = line.slice(6);
        if (line.startsWith("a=candidate:")) heldCandidates.push({ candidate: line.slice(2), mid });
      }
      peer.setRemoteDescription(
        lines
          .filter((line) => !line.startsWith("a=candidate:") && line !== "a=end-of-candidates")
          .join("\r\n"),
        value.type,
      );
    },
  };
}
