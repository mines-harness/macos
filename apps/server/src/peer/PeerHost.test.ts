import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { createPeerIdentity, signPeerSignal } from "@t3tools/shared/minesPeerTrust";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerHost from "./PeerHost.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import { createNodePeer } from "./NodePeer.ts";
vi.mock("./NodePeer.ts", () => ({ createNodePeer: vi.fn() }));
const sdp =
  "v=0\r\na=fingerprint:sha-256 " +
  Array(32).fill("AB").join(":") +
  "\r\na=candidate:1 1 UDP 1 192.168.1.2 5000 typ host\r\n";
const setup = () => {
  const owner = createPeerIdentity(new Uint8Array(32).fill(31), "Owner");
  const friend = createPeerIdentity(new Uint8Array(32).fill(32), "Friend");
  const activate = vi.fn();
  const session: PeerSession = {
    remoteDeviceId: friend.device.deviceId,
    send: async () => {},
    subscribe: () => () => {},
    close: () => {},
    closed: new Promise(() => {}),
  };
  vi.mocked(createNodePeer)
    .mockReset()
    .mockReturnValue({
      description: Promise.resolve({ type: "answer", sdp }),
      session: Promise.resolve(session),
      acceptDescription: () => {},
      activateCandidates: activate,
      close: () => {},
    });
  return {
    owner,
    friend,
    activate,
    layer: PeerHost.layer.pipe(
      Layer.provide(
        Layer.mock(PeerTrustStore.PeerTrustStore)({
          identity: Effect.succeed(owner),
          list: Effect.succeed([friend.device]),
        }),
      ),
    ),
  };
};

describe("peer host group isolation", () => {
  it.effect("refuses group-scoped offers on private acceptance even for an approved device", () => {
    const h = setup();
    return Effect.gen(function* () {
      const host = yield* PeerHost.PeerHost;
      const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const signal = signPeerSignal(h.friend, {
        sessionId: "session_test_12345678",
        sharedGroupKey: "shared_group_12345678",
        toDeviceId: h.owner.device.deviceId,
        issuedAt,
        description: { type: "offer", sdp },
      });
      expect(yield* host.accept(signal, []).pipe(Effect.flip)).toMatchObject({
        code: "unapproved-device",
      });
      expect(createNodePeer).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("opens only the shared channel and rejects a downgraded ready acknowledgement", () => {
    const h = setup();
    return Effect.gen(function* () {
      const host = yield* PeerHost.PeerHost;
      const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const base = {
        sessionId: "session_test_12345678",
        toDeviceId: h.owner.device.deviceId,
        issuedAt,
        description: { type: "offer" as const, sdp },
      };
      const signal = signPeerSignal(h.friend, { ...base, sharedGroupKey: "shared_group_12345678" });
      const accepted = yield* host.accept(signal, [], h.friend.device);
      expect(accepted.answer.sharedGroupKey).toBe(signal.sharedGroupKey);
      expect(createNodePeer).toHaveBeenCalledWith(
        expect.objectContaining({ allowedChannels: ["shared-group"] }),
      );
      const ready = signPeerSignal(h.friend, {
        ...base,
        description: accepted.answer.description,
        phase: "ready",
      });
      expect(yield* accepted.acknowledge(ready).pipe(Effect.flip)).toMatchObject({
        code: "invalid-signature",
      });
      expect(h.activate).not.toHaveBeenCalled();
      yield* accepted.acknowledge(
        signPeerSignal(h.friend, {
          ...base,
          sharedGroupKey: "shared_group_12345678",
          description: accepted.answer.description,
          phase: "ready",
        }),
      );
      expect(h.activate).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(h.layer));
  });
});
