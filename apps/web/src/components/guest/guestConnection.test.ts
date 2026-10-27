import { describe, expect, it, vi } from "vite-plus/test";

import { connectGuestStream } from "./guestConnection";

function setup(status = 503) {
  const sources: Array<EventTarget & { readyState: number; close: () => void }> = [];
  class Source extends EventTarget {
    static readonly CLOSED = 2;
    readyState = 1;
    constructor() {
      super();
      sources.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  vi.stubGlobal("EventSource", Source);
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  vi.useFakeTimers();
  const onEvent = vi.fn();
  const onRejected = vi.fn();
  const onReconnecting = vi.fn();
  const stop = connectGuestStream({
    streamUrl: "/stream",
    sessionUrl: "/session",
    onEvent,
    onRejected,
    onReconnecting,
  });
  return {
    sources,
    fetch,
    stop,
    onEvent,
    onRejected,
    onReconnecting,
    [Symbol.dispose]() {
      stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

function fail(source: EventTarget & { close: () => void }) {
  source.close();
  source.dispatchEvent(new Event("error"));
}

describe("guest stream recovery", () => {
  it.each([429, 502, 503])(
    "reconnects a still-valid conversation after proxy status %i",
    async (status) => {
      using connection = setup(status);
      fail(connection.sources[0]!);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connection.sources).toHaveLength(2);
      expect(connection.onRejected).not.toHaveBeenCalled();
      expect(connection.fetch).toHaveBeenCalledWith(
        "/session",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      connection.sources[1]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "view",
            view: {
              shareId: "share",
              title: "Shared conversation",
              guestName: "Sam",
              expiresAt: "2026-10-27T00:00:00.000Z",
              messages: [],
              model: { driver: null, name: "model" },
            },
          }),
        }),
      );
      expect(connection.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "view" }));
      expect(connection.onReconnecting).toHaveBeenLastCalledWith(false);
    },
  );

  it("ends a revoked session instead of reconnecting it", async () => {
    using connection = setup(403);
    fail(connection.sources[0]!);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connection.sources).toHaveLength(1);
    expect(connection.onRejected).toHaveBeenCalledOnce();
  });

  it("cancels a pending probe on unmount without starting another stream", async () => {
    using connection = setup();
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    connection.fetch.mockReturnValue(response);
    fail(connection.sources[0]!);
    connection.stop();
    resolveResponse(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connection.sources).toHaveLength(1);
    expect(connection.onRejected).not.toHaveBeenCalled();
  });

  it("leaves the browser's own reconnect attempt in charge while it is connecting", async () => {
    using connection = setup();
    connection.sources[0]!.readyState = 0;
    connection.sources[0]!.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connection.fetch).not.toHaveBeenCalled();
    expect(connection.sources).toHaveLength(1);
    expect(connection.onReconnecting).toHaveBeenCalledWith(true);
  });
});
