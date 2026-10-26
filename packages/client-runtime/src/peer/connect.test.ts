import { expect, it } from "@effect/vitest";
import type { PeerSignal } from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import {
  createPeerIdentity,
  signPeerSignal,
  verifyPeerSignal,
} from "@t3tools/shared/minesPeerTrust";
import { connectDirectPeer } from "./connect.ts";

it("acknowledges the exact signed answer only after installing its fingerprint", async () => {
  const identity = createPeerIdentity(new Uint8Array(32).fill(1), "Phone");
  const host = createPeerIdentity(new Uint8Array(32).fill(2), "Host");
  const sdp = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill("AB").join(":")}\r\na=candidate:1 1 UDP 1 127.0.0.1 12345 typ host\r\n`;
  let receive: (signal: PeerSignal) => void = () => {};
  let offered!: () => void;
  const offerSent = new Promise<void>((resolve) => {
    offered = resolve;
  });
  let applied!: () => void;
  const fingerprintInstalled = new Promise<void>((resolve) => {
    applied = resolve;
  });
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const session: PeerSession = {
    remoteDeviceId: host.device.deviceId,
    closed,
    close,
    async send() {},
    subscribe: () => () => {},
  };
  const sent: PeerSignal[] = [];
  const connecting = connectDirectPeer({
    identity,
    approved: host.device,
    sessionId: "session_identifier_001",
    nowSeconds: () => 100,
    stunServers: [],
    signal: new AbortController().signal,
    gateway: {
      async send(signal) {
        sent.push(signal);
        if (signal.description.type === "offer") offered();
      },
      subscribe(listener) {
        receive = listener;
        return () => {};
      },
    },
    createEndpoint: () => ({
      description: Promise.resolve({ type: "offer", sdp }),
      session: Promise.resolve(session),
      acceptDescription: () => fingerprintInstalled,
      close,
    }),
  });
  try {
    await offerSent;
    const answer = signPeerSignal(host, {
      sessionId: "session_identifier_001",
      toDeviceId: identity.device.deviceId,
      issuedAt: 100,
      description: { type: "answer", sdp },
    });
    receive(answer);
    expect(sent).toHaveLength(1);
    applied();
    expect(await connecting).toBe(session);
    const ready = verifyPeerSignal(sent[1], identity.device, host.device.deviceId, 100);
    expect(ready.phase).toBe("ready");
    expect(ready.description).toEqual(answer.description);
    expect(ready.sessionId).toBe(answer.sessionId);
  } finally {
    close();
  }
});
