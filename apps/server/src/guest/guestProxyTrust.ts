// @effect-diagnostics-next-line nodeBuiltinImport:off -- This synchronous boundary needs a process token and timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

const tokenHeader = "x-mines-guest-proxy-token";
const ipHeader = "x-mines-guest-proxy-ip";
const processToken = NodeCrypto.randomBytes(32);
const encodedToken = processToken.toString("hex");

const isLoopback = (remoteAddress: string | undefined): boolean => {
  if (remoteAddress === "127.0.0.1") return true;
  if (
    remoteAddress === undefined ||
    remoteAddress.includes("%") ||
    NodeNet.isIP(remoteAddress) !== 6
  ) {
    return false;
  }
  const hostname = new URL(`http://[${remoteAddress}]`).hostname;
  // The bridge dials 127.0.0.1 or ::1; other addresses in 127/8 are outside this boundary.
  return hostname === "[::1]" || hostname === "[::ffff:7f00:1]";
};

export function guestProxyHeaders(ipAddress: string): Readonly<Record<string, string>> {
  return Object.freeze({ [tokenHeader]: encodedToken, [ipHeader]: ipAddress });
}

export function verifiedGuestProxyIp(
  headers: Readonly<Record<string, string | undefined>>,
  remoteAddress: string | undefined,
): string | null {
  if (!isLoopback(remoteAddress)) return null;

  let token: string | undefined;
  let ipAddress: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    switch (name.toLowerCase()) {
      case tokenHeader:
        if (token !== undefined || typeof value !== "string") return null;
        token = value;
        break;
      case ipHeader:
        if (ipAddress !== undefined || typeof value !== "string") return null;
        ipAddress = value;
        break;
    }
  }

  if (
    token === undefined ||
    token.length !== encodedToken.length ||
    !/^[0-9a-f]+$/.test(token) ||
    ipAddress === undefined ||
    ipAddress.includes("%") ||
    NodeNet.isIP(ipAddress) === 0
  ) {
    return null;
  }
  return NodeCrypto.timingSafeEqual(Buffer.from(token, "hex"), processToken) ? ipAddress : null;
}
