import { describe, expect, it, vi } from "vite-plus/test";

import { resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        identity: { controlUrl: "https://mines.example.test" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      identity: { controlUrl: "https://mines.example.test/" },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });
  it("rejects insecure account services", () => {
    expect(
      resolveCloudPublicConfig({ identity: { controlUrl: "http://mines.example.test" } }).identity
        .controlUrl,
    ).toBeNull();
  });
});
