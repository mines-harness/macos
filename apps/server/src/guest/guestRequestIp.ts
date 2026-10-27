import * as NodeNet from "node:net";

import { verifiedGuestProxyIp } from "./guestProxyTrust.ts";

const normalizeIp = (value: string | undefined): string | null => {
  if (!value || value.includes("%")) return null;
  if (NodeNet.isIP(value) === 4) return value;
  if (NodeNet.isIP(value) !== 6) return null;
  const address = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/u.exec(address);
  if (mapped === null) return address;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
};

export function guestRequestIp(input: {
  readonly ipAddress?: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly relayHostname: string | null;
}): string | null {
  const verified = verifiedGuestProxyIp(input.headers, input.ipAddress);
  if (verified !== null) return normalizeIp(verified);
  const peer = normalizeIp(input.ipAddress);
  if (peer === null) return null;
  // Only the running loopback cloudflared connector is a trusted source of this edge header.
  const localConnector =
    (peer === "127.0.0.1" || peer === "::1") &&
    input.relayHostname !== null &&
    input.headers.host === input.relayHostname;
  return localConnector && input.headers["cf-connecting-ip"] !== undefined
    ? normalizeIp(input.headers["cf-connecting-ip"])
    : peer;
}
