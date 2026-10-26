import { describe, expect, it } from "vite-plus/test";

import { parseAllowedOrigins } from "./allowedOrigins.ts";

describe("device-service allowed origins", () => {
  it("preserves desktop origins for CORS and Clerk authorized-party verification", () => {
    const origins = parseAllowedOrigins("https://mines.gemstud.io, mines://app/, mines-dev://app");

    expect(origins).toEqual(["https://mines.gemstud.io", "mines://app", "mines-dev://app"]);
    expect(origins).not.toContain("null");
  });

  it("normalizes browser origins without changing their port", () => {
    expect(parseAllowedOrigins("https://MINES.gemstud.io:443/, http://localhost:5733")).toEqual([
      "https://mines.gemstud.io",
      "http://localhost:5733",
    ]);
  });

  it.each([
    "null",
    "file:///Applications/mines.app",
    "other://app",
    "mines://other",
    "mines://app:1234",
    "mines://user@app",
    "mines://app/path",
    "https://mines.gemstud.io/path",
    "https://mines.gemstud.io?token=value",
    "https://mines.gemstud.io#fragment",
    "https://user:password@mines.gemstud.io",
    "https://mines.gemstud.io,",
  ])("rejects non-origin configuration: %s", (origin) => {
    expect(() => parseAllowedOrigins(origin)).toThrow();
  });
});
