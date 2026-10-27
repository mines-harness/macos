import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  guestProxyPath,
  GuestProxyHostFrame,
  GuestProxyRequest,
  GUEST_PROXY_CHUNK_BYTES,
} from "./guestProxy.ts";

const isHostFrame = Schema.is(GuestProxyHostFrame);
const isRequest = Schema.is(GuestProxyRequest);

describe("guest proxy boundary", () => {
  it("allows guest streams, files and submissions without allowing owner APIs", () => {
    expect(guestProxyPath("/api/guest/stream?share=test", "GET")).toBe(true);
    expect(guestProxyPath("/api/guest/attachment?share=test&id=file", "GET")).toBe(true);
    expect(guestProxyPath("/api/guest/messages?share=test", "POST")).toBe(true);
    for (const path of [
      "/api/projects",
      "/api/guest/../projects",
      "/api/guest/%2e%2e/projects",
      "//evil/api/guest/stream",
      "/api/guest/stream#secret",
      "/api/guest/stream\r\nX: bad",
      "/api/guest/stream/extra",
      "/api/guest/hosts/device/stream",
    ]) {
      expect(guestProxyPath(path, "GET")).toBe(false);
    }
    expect(guestProxyPath("/api/guest/redeem", "GET")).toBe(false);
    expect(guestProxyPath("/api/guest/stream", "POST")).toBe(false);
  });

  it("bounds streamed frames and refuses malformed base64 before forwarding bytes", () => {
    const id = "request_0123456789";
    expect(
      isHostFrame({
        type: "chunk",
        id,
        body: Buffer.alloc(GUEST_PROXY_CHUNK_BYTES).toString("base64"),
      }),
    ).toBe(true);
    expect(
      isHostFrame({
        type: "chunk",
        id,
        body: Buffer.alloc(GUEST_PROXY_CHUNK_BYTES + 1).toString("base64"),
      }),
    ).toBe(false);
    expect(isHostFrame({ type: "chunk", id, body: "malformed=" })).toBe(false);
    expect(
      isRequest({
        type: "request",
        id,
        method: "DELETE",
        path: "/api/guest/messages",
        headers: {},
        ipAddress: "127.0.0.1",
      }),
    ).toBe(false);
  });
});
