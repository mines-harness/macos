import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  createPeerIdentity,
  signPeerSignal,
  verifyPeerSignal,
} from "@t3tools/shared/minesPeerTrust";
import { createNodePeer } from "./NodePeer.ts";
import { createPeerSessionRegistry } from "./PeerSessionRegistry.ts";

it.live("opens a signed native direct connection and exchanges fragmented data", () =>
  Effect.promise(async () => {
    const hostIdentity = createPeerIdentity(new Uint8Array(32).fill(11), "Host");
    const clientIdentity = createPeerIdentity(new Uint8Array(32).fill(22), "Phone");
    const client = createNodePeer({
      remoteDeviceId: hostIdentity.device.deviceId,
      initiator: true,
      stunServers: [],
    });
    const host = createNodePeer({
      remoteDeviceId: clientIdentity.device.deviceId,
      initiator: false,
      stunServers: [],
    });
    const sessions = createPeerSessionRegistry();
    sessions.addEndpoint(hostIdentity.device.deviceId, client.close);
    try {
      const offer = signPeerSignal(clientIdentity, {
        sessionId: "session_identifier_0001",
        toDeviceId: hostIdentity.device.deviceId,
        issuedAt: 100,
        description: await client.description,
      });
      host.acceptDescription(
        verifyPeerSignal(offer, clientIdentity.device, hostIdentity.device.deviceId, 100)
          .description,
      );
      const answer = signPeerSignal(hostIdentity, {
        sessionId: offer.sessionId,
        toDeviceId: clientIdentity.device.deviceId,
        issuedAt: 100,
        description: await host.description,
      });
      client.acceptDescription(
        verifyPeerSignal(answer, hostIdentity.device, clientIdentity.device.deviceId, 100)
          .description,
      );
      const acknowledgement = signPeerSignal(clientIdentity, {
        sessionId: offer.sessionId,
        toDeviceId: hostIdentity.device.deviceId,
        issuedAt: 100,
        description: answer.description,
        phase: "ready",
      });
      expect(
        verifyPeerSignal(acknowledgement, clientIdentity.device, hostIdentity.device.deviceId, 100)
          .phase,
      ).toBe("ready");
      host.activateCandidates();
      const [outgoing, incoming] = await Promise.all([client.session, host.session]);
      sessions.publish(outgoing);
      const received = new Promise<Uint8Array>((resolve) =>
        incoming.subscribe("resource", resolve),
      );
      const payload = new TextEncoder().encode("newest history first ".repeat(5000));
      await outgoing.send("resource", payload);
      expect(await received).toEqual(payload);
      const reply = new Promise<Uint8Array>((resolve) => outgoing.subscribe("rpc", resolve));
      await incoming.send("rpc", new Uint8Array([1, 2, 3]));
      expect(await reply).toEqual(new Uint8Array([1, 2, 3]));
      sessions.disconnectDevice(hostIdentity.device.deviceId);
      await outgoing.closed;
      await expect(outgoing.send("rpc", new Uint8Array([4]))).rejects.toMatchObject({
        code: "closed",
      });
    } finally {
      client.close();
      host.close();
    }
  }),
);
