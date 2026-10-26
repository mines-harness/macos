import { expect, it, vi } from "@effect/vitest";
import type { PeerChannel, PeerResourceRequest } from "@t3tools/contracts/minesPeer";
import { peerFetch } from "./minesPeerAdapters.ts";
import type { PeerSession } from "./minesPeerTransport.ts";

function peer(responseBody = "b2s=") {
  const listeners = new Map<PeerChannel, (bytes: Uint8Array) => void>();
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const requests: PeerResourceRequest[] = [];
  const session: PeerSession = {
    remoteDeviceId: "test_peer",
    closed,
    close,
    subscribe(channel, listener) {
      listeners.set(channel, listener);
      return () => {
        listeners.delete(channel);
      };
    },
    async send(channel, bytes) {
      const request: PeerResourceRequest = JSON.parse(new TextDecoder().decode(bytes));
      requests.push(request);
      listeners.get(channel)?.(
        new TextEncoder().encode(
          JSON.stringify({
            id: request.id,
            status: 200,
            headers: {},
            encoding: "base64",
            body: responseBody,
          }),
        ),
      );
    },
  };
  return { session, requests };
}

it.each(["GET", "HEAD"])(
  "omits %s bodies when native Request has no body property",
  async (method) => {
    const NativeRequest = Request;
    using _request = vi.spyOn(globalThis, "Request").mockImplementation(
      class extends NativeRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          super(input, init);
          Object.defineProperty(this, "body", { value: undefined });
        }
        override async arrayBuffer(): Promise<ArrayBuffer> {
          throw new Error("A native no-body request must not invoke FileReader");
        }
      },
    );
    const fixture = peer();
    try {
      const response = await peerFetch(fixture.session, "http://peer.local")(
        "http://peer.local/api/test",
        { method },
      );
      expect(await response.text()).toBe("ok");
      expect(fixture.requests[0]).not.toHaveProperty("body");
    } finally {
      fixture.session.close();
    }
  },
);

it("preserves JSON pairing bodies and the caller bearer token", async () => {
  const fixture = peer();
  try {
    await peerFetch(fixture.session, "http://peer.local")("http://peer.local/api/pair", {
      method: "POST",
      headers: { authorization: "Bearer caller", "content-type": "application/json" },
      body: '{"token":"one-time"}',
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/pair",
      headers: { authorization: "Bearer caller", "content-type": "application/json" },
      body: "eyJ0b2tlbiI6Im9uZS10aW1lIn0=",
    });
  } finally {
    fixture.session.close();
  }
});

it("rejects the pending fetch when a malformed response closes its session", async () => {
  const fixture = peer("invalid base64 !");
  await expect(
    peerFetch(fixture.session, "http://peer.local")("http://peer.local/api/test"),
  ).rejects.toMatchObject({ code: "closed" });
  await fixture.session.closed;
});
