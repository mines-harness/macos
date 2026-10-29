export {
  GUEST_PROXY_MAX_REQUEST_BYTES,
  GUEST_PROXY_CHUNK_BYTES,
  GUEST_PROXY_MAX_PENDING,
  GuestProxyRequest,
  GuestProxyCancel,
  GuestProxyAck,
  GuestProxyResponseHead,
  GuestProxyChunk,
  GuestProxyEnd,
  GuestProxyError,
  GuestProxyControlFrame,
  GuestProxyHostFrame,
} from "@t3tools/contracts/guestProxy";

const GET_ROUTES = new Set(["session", "stream", "item", "command-output", "render", "attachment"]);
const POST_ROUTES = new Set(["redeem", "messages", "activity"]);

/** A guest transport cannot reach any owner API, encoded path, or arbitrary proxy target. */
export function guestProxyPath(path: string, method: string): boolean {
  if (path.length > 4096 || /[\\\r\n\0#]/.test(path)) return false;
  const [pathname] = path.split("?", 1);
  if (!pathname?.startsWith("/api/guest/")) return false;
  const suffix = pathname.slice("/api/guest/".length);
  return method === "GET"
    ? GET_ROUTES.has(suffix)
    : method === "POST"
      ? POST_ROUTES.has(suffix)
      : (method === "PATCH" || method === "DELETE") && suffix === "messages";
}
