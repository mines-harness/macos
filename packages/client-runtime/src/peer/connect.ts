import { PeerError, type PeerDevice, type PeerSignal } from "@t3tools/contracts/minesPeer";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import {
  signPeerSignal,
  verifyPeerSignal,
  type PeerIdentity,
} from "@t3tools/shared/minesPeerTrust";

import { createBrowserPeer, type BrowserPeerEndpoint } from "./browser.ts";

export interface PeerSignalGateway {
  readonly send: (signal: PeerSignal) => Promise<void>;
  readonly subscribe: (listener: (signal: PeerSignal) => void) => () => void;
}

export async function connectDirectPeer(input: {
  readonly identity: PeerIdentity;
  readonly approved: PeerDevice;
  readonly gateway: PeerSignalGateway;
  readonly sessionId: string;
  readonly nowSeconds: () => number;
  readonly stunServers: ReadonlyArray<string>;
  readonly signal: AbortSignal;
  readonly createEndpoint?: typeof createBrowserPeer;
}): Promise<PeerSession> {
  if (input.signal.aborted) throw new PeerError({ code: "closed" });
  const endpoint: BrowserPeerEndpoint = (input.createEndpoint ?? createBrowserPeer)({
    remoteDeviceId: input.approved.deviceId,
    initiator: true,
    stunServers: input.stunServers,
  });
  let answered = false;
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let fail!: (error: PeerError) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const abort = () => {
    endpoint.close();
    fail(new PeerError({ code: "closed" }));
  };
  input.signal.addEventListener("abort", abort, { once: true });
  const unsubscribe = input.gateway.subscribe((raw) => {
    if (
      raw.sessionId !== input.sessionId ||
      raw.fromDeviceId !== input.approved.deviceId ||
      answered
    )
      return;
    try {
      const answer = verifyPeerSignal(
        raw,
        input.approved,
        input.identity.device.deviceId,
        input.nowSeconds(),
      );
      if (answer.phase || answer.description.type !== "answer")
        throw new PeerError({ code: "invalid-description" });
      answered = true;
      void endpoint
        .acceptDescription(answer.description)
        .then(() =>
          input.gateway.send(
            signPeerSignal(input.identity, {
              sessionId: input.sessionId,
              toDeviceId: input.approved.deviceId,
              issuedAt: input.nowSeconds(),
              description: answer.description,
              phase: "ready",
            }),
          ),
        )
        .then(acknowledge)
        .catch(() => fail(new PeerError({ code: "invalid-description" })));
    } catch {
      fail(new PeerError({ code: "invalid-signature" }));
    }
  });
  try {
    const description = await Promise.race([endpoint.description, failed]);
    await input.gateway.send(
      signPeerSignal(input.identity, {
        sessionId: input.sessionId,
        toDeviceId: input.approved.deviceId,
        issuedAt: input.nowSeconds(),
        description,
      }),
    );
    const [session] = await Promise.race([Promise.all([endpoint.session, acknowledged]), failed]);
    return session;
  } catch (error) {
    endpoint.close();
    throw error;
  } finally {
    unsubscribe();
    input.signal.removeEventListener("abort", abort);
  }
}
