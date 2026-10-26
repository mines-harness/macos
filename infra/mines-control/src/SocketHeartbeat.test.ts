import { expect, it, vi } from "vite-plus/test";
import { makeSocketHeartbeat } from "./SocketHeartbeat.ts";

const socket = () => ({ readyState: 1, OPEN: 1, ping: vi.fn(), terminate: vi.fn() });

it("keeps responding clients alive and terminates silent clients once", () => {
  const heartbeat = makeSocketHeartbeat();
  const responding = socket();
  const silent = socket();
  heartbeat.track(responding);
  heartbeat.track(silent);
  heartbeat.pulse();
  expect(silent.terminate).not.toHaveBeenCalled();
  heartbeat.pong(responding);
  heartbeat.pulse();
  expect(responding.ping).toHaveBeenCalledTimes(2);
  expect(responding.terminate).not.toHaveBeenCalled();
  expect(silent.terminate).toHaveBeenCalledTimes(1);
  heartbeat.pong(silent);
  heartbeat.pong(responding);
  heartbeat.pulse();
  expect(silent.terminate).toHaveBeenCalledTimes(1);
});

it("removes closed clients and handles a failed ping", () => {
  const heartbeat = makeSocketHeartbeat();
  const removed = socket();
  const failed = socket();
  const untrack = heartbeat.track(removed);
  untrack();
  failed.ping.mockImplementation(() => {
    throw new Error("closed");
  });
  heartbeat.track(failed);
  heartbeat.pulse();
  heartbeat.pulse();
  expect(removed.ping).not.toHaveBeenCalled();
  expect(removed.terminate).not.toHaveBeenCalled();
  expect(failed.terminate).toHaveBeenCalledTimes(1);
});
