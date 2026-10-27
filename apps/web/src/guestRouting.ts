const HOST_ID = /^[a-zA-Z0-9_-]{16,128}$/;

/** Public guest pages address one authenticated host; legacy tunnel pages stay same-origin. */
export function guestApiUrl(
  path: string,
  search = typeof window === "undefined" ? "" : window.location.search,
): string {
  if (!path.startsWith("/api/guest/") || path.startsWith("/api/guest/hosts/")) return path;
  const hosts = new URLSearchParams(search).getAll("host");
  if (hosts.length === 0) return path;
  if (hosts.length !== 1 || !HOST_ID.test(hosts[0] ?? "")) {
    return `/api/guest/hosts/invalid/${path.slice("/api/guest/".length)}`;
  }
  return `/api/guest/hosts/${hosts[0]}/${path.slice("/api/guest/".length)}`;
}
