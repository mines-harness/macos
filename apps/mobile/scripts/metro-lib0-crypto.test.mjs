import { describe, expect, it, vi } from "vite-plus/test";
import { resolveNativeLib0Crypto } from "./metro-lib0-crypto.cjs";

describe("native Yjs entropy resolution", () => {
  it.each([
    ["ios", "/app/node_modules/.pnpm/lib0@0.2.119/node_modules/lib0/random.js"],
    ["android", "/app/node_modules/.pnpm/lib0@0.2.119/node_modules/lib0/dist/random.cjs"],
    ["android", "C:\\app\\node_modules\\lib0\\dist\\random.cjs"],
  ])("uses Expo's native getRandomValues on %s", (platform, originModulePath) => {
    const resolved = { type: "sourceFile", filePath: "/expo/Crypto.js" };
    const context = { originModulePath, resolveRequest: vi.fn(() => resolved) };
    expect(resolveNativeLib0Crypto(context, "lib0/webcrypto", platform, "/app/index.ts")).toBe(
      resolved,
    );
    expect(context.resolveRequest).toHaveBeenCalledWith(
      { ...context, originModulePath: "/app/index.ts" },
      "expo-crypto",
      platform,
    );
  });

  it.each([
    ["web", "lib0/webcrypto", "/app/node_modules/lib0/random.js"],
    ["ios", "lib0/webcrypto", "/app/node_modules/lib0/crypto/aes-gcm.js"],
    ["ios", "lib0/webcrypto", "/app/node_modules/lib0/dist/ecdsa.cjs"],
    ["ios", "lib0/webcrypto", "/app/src/random.js"],
    ["ios", "another-package/webcrypto", "/app/node_modules/lib0/random.js"],
  ])("preserves non-entropy WebCrypto resolution (%s, %s, %s)", (platform, name, origin) => {
    const context = { originModulePath: origin, resolveRequest: vi.fn() };
    expect(resolveNativeLib0Crypto(context, name, platform, "/app/index.ts")).toBeNull();
    expect(context.resolveRequest).not.toHaveBeenCalled();
  });

  it("propagates a missing native crypto dependency without falling back to weak randomness", () => {
    const context = {
      originModulePath: "/app/node_modules/lib0/random.js",
      resolveRequest: () => {
        throw new Error("expo-crypto is unavailable");
      },
    };
    expect(() =>
      resolveNativeLib0Crypto(context, "lib0/webcrypto", "ios", "/app/index.ts"),
    ).toThrow("expo-crypto is unavailable");
  });
});
