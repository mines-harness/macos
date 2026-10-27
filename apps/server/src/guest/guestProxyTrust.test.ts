import { describe, expect, it } from "@effect/vitest";

import { guestProxyHeaders, verifiedGuestProxyIp } from "./guestProxyTrust.ts";

const tokenHeader = "x-mines-guest-proxy-token";
const ipHeader = "x-mines-guest-proxy-ip";
const clientIp = "198.51.100.42";

describe("guest proxy trust", () => {
  it("issues a process token shared across requests without sharing header objects", () => {
    const first = guestProxyHeaders(clientIp);
    const second = guestProxyHeaders("2001:db8::42");

    expect(Object.keys(first).sort()).toEqual([ipHeader, tokenHeader]);
    expect(first[tokenHeader]).toMatch(/^[0-9a-f]{64}$/);
    expect(second[tokenHeader]).toBe(first[tokenHeader]);
    expect(second).not.toBe(first);
    expect(first[ipHeader]).toBe(clientIp);
    expect(second[ipHeader]).toBe("2001:db8::42");
    expect(verifiedGuestProxyIp(first, "127.0.0.1")).toBe(clientIp);
    expect(verifiedGuestProxyIp(second, "127.0.0.1")).toBe("2001:db8::42");
  });

  it.each([
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:7F00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
  ])("trusts authenticated requests over loopback %s", (remoteAddress) => {
    expect(verifiedGuestProxyIp(guestProxyHeaders(clientIp), remoteAddress)).toBe(clientIp);
  });

  it.each([
    undefined,
    "",
    "localhost",
    "127.0.0.2",
    "127.1.2.3",
    "127.255.255.255",
    "127.0.0.1.example.com",
    "127.0.0.1:3773",
    "127.1",
    "2130706433",
    "0177.0.0.1",
    " 127.0.0.1",
    "127.0.0.1\n",
    "192.0.2.1",
    "0.0.0.0",
    "::",
    "::2",
    "::127.0.0.1",
    "::ffff:127.0.0.2",
    "::ffff:192.0.2.1",
    "[::1]",
    "::1%lo0",
    "::ffff:127.0.0.1%lo0",
    "::1 ",
    "::1, 127.0.0.1",
  ])("rejects transport address %s even with genuine headers", (remoteAddress) => {
    expect(verifiedGuestProxyIp(guestProxyHeaders(clientIp), remoteAddress)).toBeNull();
  });

  it("rejects missing trust headers and ignores unrelated forwarding headers", () => {
    const headers = guestProxyHeaders(clientIp);

    for (const missing of [tokenHeader, ipHeader]) {
      expect(verifiedGuestProxyIp({ ...headers, [missing]: undefined }, "127.0.0.1")).toBeNull();
    }
    expect(
      verifiedGuestProxyIp(
        { "x-forwarded-for": clientIp, "cf-connecting-ip": clientIp },
        "127.0.0.1",
      ),
    ).toBeNull();
    expect(
      verifiedGuestProxyIp(
        { ...headers, "x-forwarded-for": "192.0.2.9", "cf-connecting-ip": "192.0.2.9" },
        "127.0.0.1",
      ),
    ).toBe(clientIp);
  });

  it("rejects forged, padded, combined, and malformed tokens", () => {
    const headers = guestProxyHeaders(clientIp);
    const token = headers[tokenHeader] ?? "";
    const forged = `${token.startsWith("0") ? "1" : "0"}${token.slice(1)}`;

    for (const candidate of [
      "",
      forged,
      token.slice(1),
      `${token}0`,
      `${token} `,
      ` ${token}`,
      `${token}\n`,
      `${token}\r\n`,
      `${token}, ${token}`,
      `${token},`,
      `${token.slice(0, -1)}g`,
      `${token.slice(0, -1)}\0`,
      "é".repeat(64),
    ]) {
      expect(
        verifiedGuestProxyIp({ ...headers, [tokenHeader]: candidate }, "127.0.0.1"),
      ).toBeNull();
    }
  });

  it.each(["192.0.2.1", "2001:db8::42", "::1", "::ffff:192.0.2.1"])(
    "returns the authenticated claimed IP %s",
    (ipAddress) => {
      expect(verifiedGuestProxyIp(guestProxyHeaders(ipAddress), "127.0.0.1")).toBe(ipAddress);
    },
  );

  it.each([
    "",
    "unknown",
    "192.0.2.999",
    "192.0.2.1:8080",
    "192.0.2.1/32",
    "192.0.002.1",
    " 192.0.2.1",
    "192.0.2.1 ",
    "192.0.2.1\n",
    "192.0.2.1\r\n",
    "192.0.2.1\0",
    "192.0.2.1, 198.51.100.1",
    "192.0.2.1, 192.0.2.1",
    "[2001:db8::1]",
    "2001:db8::1/64",
    "fe80::1%eth0",
    "::1%lo0",
  ])("rejects malformed or multiple claimed IPs %s", (ipAddress) => {
    expect(verifiedGuestProxyIp(guestProxyHeaders(ipAddress), "127.0.0.1")).toBeNull();
  });

  it("accepts single headers case-insensitively", () => {
    const headers = guestProxyHeaders(clientIp);

    expect(
      verifiedGuestProxyIp(
        {
          "X-Mines-Guest-Proxy-Token": headers[tokenHeader],
          "X-Mines-Guest-Proxy-IP": headers[ipHeader],
        },
        "127.0.0.1",
      ),
    ).toBe(clientIp);
  });

  it("rejects duplicate case variants even when their values match", () => {
    const headers = guestProxyHeaders(clientIp);

    for (const name of [tokenHeader, ipHeader]) {
      expect(
        verifiedGuestProxyIp({ ...headers, [name.toUpperCase()]: headers[name] }, "127.0.0.1"),
      ).toBeNull();
      expect(
        verifiedGuestProxyIp({ [name.toUpperCase()]: undefined, ...headers }, "127.0.0.1"),
      ).toBeNull();
    }
  });

  it("rejects inherited trust headers", () => {
    const headers: Record<string, string | undefined> = Object.create(guestProxyHeaders(clientIp));

    expect(verifiedGuestProxyIp(headers, "127.0.0.1")).toBeNull();
  });
});
