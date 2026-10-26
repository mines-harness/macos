import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { ContactsGroupAccessProof, SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import { PeerError, type PeerDevice } from "@t3tools/contracts/minesPeer";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PeerIdentity } from "./minesPeerTrust.ts";
import { stableStringify } from "./relaySigning.ts";

const decode = Schema.decodeUnknownSync(ContactsGroupAccessProof);
const encoder = new TextEncoder();

export function signSharedGroupAccessProof(
  identity: PeerIdentity,
  input: {
    readonly groupKey: string;
    readonly toDeviceId: string;
    readonly issuedAt: number;
    readonly nonce: string;
  },
): ContactsGroupAccessProof {
  const unsigned = { version: 1 as const, ...input, fromDeviceId: identity.device.deviceId };
  return decode({
    ...unsigned,
    signature: Base64Url.encode(
      ed25519.sign(encoder.encode(stableStringify(unsigned)), identity.privateKey),
    ),
  });
}

export function verifySharedGroupAccessProof(
  value: unknown,
  device: PeerDevice,
  nowSeconds: number,
): ContactsGroupAccessProof {
  const proof = decode(value);
  if (proof.fromDeviceId !== device.deviceId) throw new PeerError({ code: "unapproved-device" });
  if (proof.issuedAt > nowSeconds + 15 || proof.issuedAt < nowSeconds - 60)
    throw new PeerError({ code: "expired-signal" });
  const { signature, ...unsigned } = proof;
  const publicKey = Result.getOrThrow(Base64Url.decode(device.publicKey));
  if (
    Base64Url.encode(sha256(publicKey)) !== device.deviceId ||
    !ed25519.verify(
      Result.getOrThrow(Base64Url.decode(signature)),
      encoder.encode(stableStringify(unsigned)),
      publicKey,
    )
  )
    throw new PeerError({ code: "invalid-signature" });
  return proof;
}

export function sharedGroupContentRevision(value: unknown): string {
  return Base64Url.encode(sha256(encoder.encode(stableStringify(value))));
}

export function sharedGroupScopeId(groupKey: string, deviceId: string): string {
  return `shared-group:${sharedGroupContentRevision([groupKey, deviceId])}`;
}

const decodeGrant = Schema.decodeUnknownSync(SharedGroupDeviceGrant);
export async function fetchSharedGroupAccess(
  controlUrl: string,
  proof: ContactsGroupAccessProof,
  signal?: AbortSignal,
  fetchRequest: typeof fetch = globalThis.fetch,
): Promise<SharedGroupDeviceGrant> {
  const url = new URL(controlUrl);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new PeerError({ code: "direct-unavailable" });
  url.pathname = "/v1/contacts/device-group-access";
  url.search = "";
  url.hash = "";
  const response = await fetchRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof),
    signal: signal ?? AbortSignal.timeout(15_000),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok)
    throw new PeerError({
      code: [401, 403, 404].includes(response.status) ? "unapproved-device" : "direct-unavailable",
    });
  const text = await response.text();
  if (text.length > 32_000) throw new PeerError({ code: "frame-too-large" });
  return decodeGrant(JSON.parse(text));
}
