import { describe, expect, it } from "@effect/vitest";

import { guestApiUrl } from "./guestRouting";

describe("guest API routing", () => {
  it("addresses public guest streams and files through the selected host", () => {
    const search = "?host=host_A-B0123456789&share=share";
    expect(guestApiUrl("/api/guest/stream?share=share", search)).toBe(
      "/api/guest/hosts/host_A-B0123456789/stream?share=share",
    );
    expect(guestApiUrl("/api/guest/attachment?share=share&id=file", search)).toBe(
      "/api/guest/hosts/host_A-B0123456789/attachment?share=share&id=file",
    );
  });

  it("keeps managed-tunnel guest routes and unrelated application paths", () => {
    expect(guestApiUrl("/api/guest/redeem", "?share=share")).toBe("/api/guest/redeem");
    expect(guestApiUrl("/api/projects", "?host=host_A-B0123456789")).toBe("/api/projects");
  });

  it.each(["../private", "short", "a".repeat(129), "host_A-B0123456789&host=other_A0123456789"])(
    "rejects malformed or ambiguous host selectors: %s",
    (host) => {
      expect(guestApiUrl("/api/guest/session?share=share", `?host=${host}`)).toBe(
        "/api/guest/hosts/invalid/session?share=share",
      );
    },
  );
});
