import { describe, expect, it } from "@effect/vitest";
import { createPeerSession, type PeerDataChannel } from "./minesPeerTransport.ts";

function wires() {
  let firstReceive = (_data: Uint8Array) => {};
  let secondReceive = (_data: Uint8Array) => {};
  let firstLow = () => {};
  let amount = 0;
  const frames: Uint8Array[] = [];
  const first: PeerDataChannel = {
    send(data) {
      frames.push(data);
      secondReceive(data);
    },
    bufferedAmount: () => amount,
    onMessage(listener) {
      firstReceive = listener;
    },
    onBufferedLow(listener) {
      firstLow = listener;
    },
    onClose() {},
    close() {},
  };
  const second: PeerDataChannel = {
    send: (data) => firstReceive(data),
    bufferedAmount: () => 0,
    onMessage(listener) {
      secondReceive = listener;
    },
    onBufferedLow() {},
    onClose() {},
    close() {},
  };
  return {
    first,
    second,
    frames,
    block() {
      amount = 256 * 1024;
    },
    release() {
      amount = 0;
      firstLow();
    },
    inject: (data: Uint8Array) => secondReceive(data),
  };
}

describe("direct peer framing", () => {
  it("keeps shared-group sessions separate from private catalog, RPC and resources", async () => {
    const control = wires();
    const bulk = wires();
    const first = createPeerSession("second", control.first, bulk.first, () => {}, [
      "shared-group",
    ]);
    const second = createPeerSession("first", control.second, bulk.second, () => {}, [
      "shared-group",
    ]);
    try {
      let received: Uint8Array | undefined;
      second.subscribe("shared-group", (data) => {
        received = data;
      });
      const data = new TextEncoder().encode("Shared group only");
      await first.send("shared-group", data);
      expect(received).toEqual(data);
      for (const channel of ["rpc", "resource", "catalog"] as const)
        await expect(first.send(channel, data)).rejects.toThrow();
    } finally {
      first.close();
      second.close();
    }
  });

  it("closes a group-only receiver when a private channel is injected", async () => {
    const control = wires();
    const bulk = wires();
    let closed = false;
    const first = createPeerSession("second", control.first, bulk.first, () => {});
    const second = createPeerSession(
      "first",
      control.second,
      bulk.second,
      () => {
        closed = true;
      },
      ["shared-group"],
    );
    try {
      await first.send("catalog", new Uint8Array([1]));
      expect(closed).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });
  it("compresses large text and retains messages received before a subscriber attaches", async () => {
    const control = wires();
    const bulk = wires();
    const first = createPeerSession("second", control.first, bulk.first, () => {});
    const second = createPeerSession("first", control.second, bulk.second, () => {});
    try {
      const payload = new TextEncoder().encode("recent assistant output ".repeat(5000));
      await first.send("resource", payload);
      let received: Uint8Array | undefined;
      second.subscribe("resource", (data) => {
        received = data;
      });
      expect(received).toEqual(payload);
      expect(bulk.frames[0]![1]! & 4).toBe(4);
      expect(bulk.frames.reduce((sum, frame) => sum + frame.length, 0)).toBeLessThan(
        payload.length / 2,
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("reassembles fragmented binary and allows RPC through a blocked bulk lane", async () => {
    const control = wires();
    const bulk = wires();
    const first = createPeerSession("second", control.first, bulk.first, () => {});
    const second = createPeerSession("first", control.second, bulk.second, () => {});
    try {
      const payload = new Uint8Array(100_000);
      let value = 1;
      for (let index = 0; index < payload.length; index++) {
        value = (Math.imul(value, 1664525) + 1013904223) | 0;
        payload[index] = value >>> 24;
      }
      const received: Uint8Array[] = [];
      second.subscribe("resource", (data) => received.push(data));
      second.subscribe("rpc", (data) => received.push(data));
      bulk.block();
      const loading = first.send("resource", payload);
      await first.send("rpc", new Uint8Array([9]));
      expect(received).toEqual([new Uint8Array([9])]);
      bulk.release();
      await loading;
      expect(received[1]).toEqual(payload);
      expect(bulk.frames.length).toBeGreaterThan(1);
      expect(bulk.frames.every((frame) => frame.length <= 16 * 1024)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("closes on oversized decoded messages before allocating decompression storage", async () => {
    const control = wires();
    const bulk = wires();
    const receiver = createPeerSession("first", control.second, bulk.second, () => {});
    const frame = new Uint8Array(10);
    frame[0] = 1;
    frame[1] = 7;
    new DataView(frame.buffer).setUint32(2, 17 * 1024 * 1024);
    bulk.inject(frame);
    await receiver.closed;
    await expect(receiver.send("rpc", new Uint8Array())).rejects.toMatchObject({ code: "closed" });
  });
});
