export function parseAllowedOrigins(value: string): string[] {
  return value.split(",").map((origin) => {
    const url = new URL(origin.trim());
    const browser = url.protocol === "https:" || url.protocol === "http:";
    const desktop =
      (url.protocol === "mines:" || url.protocol === "mines-dev:") &&
      url.hostname === "app" &&
      url.port === "";
    if (
      (!browser && !desktop) ||
      url.username ||
      url.password ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      throw new Error("MINES_ALLOWED_ORIGINS contains an unsupported origin.");
    }
    // Node treats custom schemes as opaque; Electron registers these as standard origins.
    return desktop ? `${url.protocol}//${url.host}` : url.origin;
  });
}
