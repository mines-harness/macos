interface HeartbeatSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly ping: () => void;
  readonly terminate: () => void;
}

export function makeSocketHeartbeat() {
  const clients = new Map<HeartbeatSocket, boolean>();
  return {
    track(socket: HeartbeatSocket) {
      clients.set(socket, true);
      return () => clients.delete(socket);
    },
    pong(socket: HeartbeatSocket) {
      if (clients.has(socket)) clients.set(socket, true);
    },
    pulse() {
      for (const [socket, alive] of clients) {
        if (!alive || socket.readyState !== socket.OPEN) {
          clients.delete(socket);
          socket.terminate();
          continue;
        }
        clients.set(socket, false);
        try {
          socket.ping();
        } catch {
          clients.delete(socket);
          socket.terminate();
        }
      }
    },
  };
}
