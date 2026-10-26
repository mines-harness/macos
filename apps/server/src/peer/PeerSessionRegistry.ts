import type { PeerSession } from "@t3tools/shared/minesPeerTransport";

export function createPeerSessionRegistry() {
  const sessions = new Set<PeerSession>();
  const endpoints = new Map<string, Set<() => void>>();
  const listeners = new Set<(session: PeerSession) => void>();
  const disconnectDevice = (deviceId: string) => {
    for (const close of endpoints.get(deviceId) ?? []) close();
    endpoints.delete(deviceId);
    for (const session of sessions) if (session.remoteDeviceId === deviceId) session.close();
  };
  return {
    disconnectDevice,
    addEndpoint(deviceId: string, close: () => void) {
      const set = endpoints.get(deviceId) ?? new Set();
      set.add(close);
      endpoints.set(deviceId, set);
      return () => {
        set.delete(close);
        if (set.size === 0 && endpoints.get(deviceId) === set) endpoints.delete(deviceId);
      };
    },
    publish(session: PeerSession) {
      sessions.add(session);
      void session.closed.then(() => sessions.delete(session));
      for (const listener of listeners) listener(session);
    },
    subscribe(listener: (session: PeerSession) => void) {
      listeners.add(listener);
      for (const session of sessions) listener(session);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      for (const deviceId of endpoints.keys()) disconnectDevice(deviceId);
      for (const session of sessions) session.close();
      sessions.clear();
    },
  };
}
