import { expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease } from "./releases";

it("does not fetch an upstream release when mines has no configured release", async () => {
  vi.stubEnv("PUBLIC_MINES_RELEASES_URL", "");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  using _restore = {
    [Symbol.dispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
  using request = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ tag_name: "v1", html_url: "https://example.com", assets: [] }),
    );

  await expect(fetchLatestRelease()).rejects.toThrow("Release not available yet");
  expect(request).not.toHaveBeenCalled();
});

it("rejects the upstream binary source even when configured", async () => {
  vi.stubEnv("PUBLIC_MINES_RELEASES_URL", "https://github.com/pingdotgg/t3code/releases");
  using _restore = { [Symbol.dispose]: () => vi.unstubAllEnvs() };
  using request = vi.spyOn(globalThis, "fetch");

  await expect(fetchLatestRelease()).rejects.toThrow("Release not available yet");
  expect(request).not.toHaveBeenCalled();
});

it("loads release metadata only from the configured mines repository", async () => {
  vi.stubEnv("PUBLIC_MINES_RELEASES_URL", "https://github.com/example/mines/releases");
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  using _restore = {
    [Symbol.dispose]() {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    },
  };
  const release = { tag_name: "v1", html_url: "https://example.com", assets: [] };
  using request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(release));

  await expect(fetchLatestRelease()).resolves.toEqual(release);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/repos/example/mines/releases/latest",
  );
});
