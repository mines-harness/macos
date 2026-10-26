import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import { createPeerIdentity } from "./minesPeerTrust.ts";
import {
  decodePeerApproval,
  decodePeerPairing,
  encodePeerApproval,
  encodePeerPairing,
  type PeerPairingPayload,
} from "./minesPeerPairing.ts";

const host = createPeerIdentity(new Uint8Array(32).fill(3), "My Mac").device;
const payload: PeerPairingPayload = {
  version: 1,
  host,
  controlUrl: "https://account.example.com",
  stunServers: ["stun:stun.example.com:3478"],
  environmentId: EnvironmentId.make("env-test"),
  pairingToken: "single-use-code",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const rawLink = (value: unknown) =>
  `mines://peer?v=1&data=${Base64Url.encode(JSON.stringify(value))}`;

describe("peer pairing codes", () => {
  it("roundtrips host pinning, environment and one-time credentials", () => {
    expect(decodePeerPairing(encodePeerPairing(payload), 100)).toEqual(payload);
    expect(decodePeerApproval(encodePeerApproval(host))).toEqual(host);
    expect(decodePeerApproval(JSON.stringify(host))).toEqual(host);
  });

  it("refuses expired codes before a token can be sent", () => {
    expect(() =>
      decodePeerPairing(encodePeerPairing(payload), Date.parse(payload.expiresAt) / 1000),
    ).toThrow("expired");
    expect(() => decodePeerPairing(rawLink({ ...payload, expiresAt: "invalid" }), 100)).toThrow();
  });

  it("rejects an unrelated device identifier and public key", () => {
    const other = createPeerIdentity(new Uint8Array(32).fill(4), "Other").device;
    expect(() =>
      decodePeerPairing(
        rawLink({ ...payload, host: { ...host, publicKey: other.publicKey } }),
        100,
      ),
    ).toThrow("fingerprint");
    expect(() => decodePeerApproval(JSON.stringify({ ...host, deviceId: other.deviceId }))).toThrow(
      "fingerprint",
    );
  });

  it("permits only HTTPS account origins and direct STUN discovery", () => {
    for (const controlUrl of [
      "http://example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
    ]) {
      expect(() => decodePeerPairing(rawLink({ ...payload, controlUrl }), 100)).toThrow();
    }
    expect(() =>
      decodePeerPairing(rawLink({ ...payload, stunServers: ["turn:relay.example.com"] }), 100),
    ).toThrow();
  });

  it("rejects wrong link kinds, versions and oversized untrusted input", () => {
    expect(() => decodePeerPairing(encodePeerApproval(host), 100)).toThrow();
    expect(() => decodePeerPairing(rawLink({ ...payload, version: 2 }), 100)).toThrow();
    expect(() => decodePeerPairing("x".repeat(32769), 100)).toThrow();
  });
});
