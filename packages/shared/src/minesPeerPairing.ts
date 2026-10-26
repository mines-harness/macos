import { PeerDevice } from "@t3tools/contracts/minesPeer";
import { EnvironmentId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { sha256 } from "@noble/hashes/sha2";
import { validateStunServers } from "./minesPeerTrust.ts";

export const PeerPairingPayload = Schema.Struct({
  version: Schema.Literal(1),
  host: PeerDevice,
  controlUrl: Schema.String.check(Schema.isMaxLength(2048)),
  stunServers: Schema.Array(Schema.String).check(Schema.isMaxLength(4)),
  environmentId: EnvironmentId,
  pairingToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
  expiresAt: Schema.String.check(Schema.isMaxLength(40)),
});
export type PeerPairingPayload = typeof PeerPairingPayload.Type;

const decodePairingJson = Schema.decodeUnknownSync(Schema.fromJsonString(PeerPairingPayload));
const encodePairingJson = Schema.encodeSync(Schema.fromJsonString(PeerPairingPayload));
const decodeDeviceJson = Schema.decodeUnknownSync(Schema.fromJsonString(PeerDevice));
const encodeDeviceJson = Schema.encodeSync(Schema.fromJsonString(PeerDevice));

function readLink(value: string, kind: "peer" | "device"): string {
  if (value.length > 32768) throw new Error("This pairing code is too large.");
  const url = new URL(value.trim());
  if (
    url.protocol !== "mines:" ||
    url.hostname !== kind ||
    url.pathname !== "" ||
    url.searchParams.get("v") !== "1" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("This is not a mines pairing code.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Result.getOrThrow(Base64Url.decode(url.searchParams.get("data") ?? "")),
  );
}

function verifyDevice(device: PeerDevice): PeerDevice {
  if (
    Base64Url.encode(sha256(Result.getOrThrow(Base64Url.decode(device.publicKey)))) !==
    device.deviceId
  ) {
    throw new Error("The device fingerprint does not match its public key.");
  }
  return device;
}

function validatePayload(payload: PeerPairingPayload): PeerPairingPayload {
  verifyDevice(payload.host);
  validateStunServers(payload.stunServers);
  const url = new URL(payload.controlUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("The account server must use an HTTPS origin.");
  }
  if (!Number.isFinite(Date.parse(payload.expiresAt)))
    throw new Error("The pairing expiry is invalid.");
  return payload;
}

export function encodePeerPairing(payload: PeerPairingPayload): string {
  return `mines://peer?v=1&data=${Base64Url.encode(encodePairingJson(validatePayload(payload)))}`;
}

export function decodePeerPairing(value: string, nowSeconds: number): PeerPairingPayload {
  const payload = validatePayload(decodePairingJson(readLink(value, "peer")));
  if (Date.parse(payload.expiresAt) <= nowSeconds * 1000)
    throw new Error("This pairing code has expired. Create a new one on your computer.");
  return payload;
}

export function encodePeerApproval(device: PeerDevice): string {
  return `mines://device?v=1&data=${Base64Url.encode(encodeDeviceJson(verifyDevice(device)))}`;
}

export function decodePeerApproval(value: string): PeerDevice {
  if (value.length > 4096) throw new Error("This device code is too large.");
  return verifyDevice(
    decodeDeviceJson(value.trim().startsWith("{") ? value.trim() : readLink(value, "device")),
  );
}
