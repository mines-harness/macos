export function isLocalMinesAccountHost(
  connection: { readonly httpBaseUrl: string; readonly peerSession?: unknown } | null,
): boolean {
  if (!connection || connection.peerSession) return false;
  try {
    const url = new URL(connection.httpBaseUrl);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
