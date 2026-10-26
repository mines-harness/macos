import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, hasMinesIdentityConfig, minesControlUrl } from "./publicConfig.ts";

afterEach(() => vi.unstubAllEnvs());

describe("self-hosted account configuration", () => {
  it("enables accounts using the operator's HTTPS control origin", () => {
    vi.stubEnv("VITE_MINES_CONTROL_URL", "https://mines.example.test/");
    expect(minesControlUrl()).toBe("https://mines.example.test");
    expect(hasMinesIdentityConfig()).toBe(true);
    expect(hasCloudPublicConfig()).toBe(false);
  });

  it.each([
    "",
    "http://mines.example.test",
    "https://user:secret@mines.example.test",
    "https://mines.example.test/path",
    "https://mines.example.test/?key=value",
  ])("rejects invalid account origins: %s", (value) => {
    vi.stubEnv("VITE_MINES_CONTROL_URL", value);
    expect(minesControlUrl()).toBeNull();
    expect(hasMinesIdentityConfig()).toBe(false);
  });

  it("does not enable inherited Clerk or relay credentials", () => {
    vi.stubEnv("VITE_MINES_CONTROL_URL", "");
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_MINES_RELAY_URL", "https://upstream.example.test");
    expect(hasMinesIdentityConfig()).toBe(false);
    expect(hasCloudPublicConfig()).toBe(false);
  });
});
