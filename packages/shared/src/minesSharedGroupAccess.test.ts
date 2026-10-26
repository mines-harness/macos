import { describe, expect, it } from "vite-plus/test";
import { createPeerIdentity } from "./minesPeerTrust.ts";
import {
  signSharedGroupAccessProof,
  verifySharedGroupAccessProof,
} from "./minesSharedGroupAccess.ts";

describe("shared group device access proof", () => {
  it("binds the group, both devices and freshness to the registered device key", () => {
    const identity = createPeerIdentity(new Uint8Array(32).fill(4), "Owner");
    const other = createPeerIdentity(new Uint8Array(32).fill(9), "Friend");
    const proof = signSharedGroupAccessProof(identity, {
      groupKey: "group-key-123456789",
      toDeviceId: other.device.deviceId,
      issuedAt: 1000,
      nonce: "nonce-1234567890123456",
    });
    expect(verifySharedGroupAccessProof(proof, identity.device, 1000)).toEqual(proof);
    for (const changed of [
      { ...proof, groupKey: "group-key-987654321" },
      { ...proof, toDeviceId: identity.device.deviceId },
      { ...proof, fromDeviceId: other.device.deviceId },
      { ...proof, issuedAt: 1001 },
    ])
      expect(() => verifySharedGroupAccessProof(changed, identity.device, 1000)).toThrow();
    expect(() => verifySharedGroupAccessProof(proof, other.device, 1000)).toThrow();
    expect(() => verifySharedGroupAccessProof(proof, identity.device, 1061)).toThrow();
    expect(() => verifySharedGroupAccessProof(proof, identity.device, 984)).toThrow();
  });
});
