import { describe, expect, it, vi } from "vite-plus/test";

import { createCatalogIdentityVerifier } from "./CatalogIdentityVerifier.ts";

const controlUrl = "https://mines.example.test";

describe("catalog identity proof", () => {
  it("verifies an opaque session with the configured mines account service", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ accountId: "account-a" }));
    const verify = createCatalogIdentityVerifier(controlUrl, fetcher);

    expect(await verify("opaque-session-token")).toBe("account-a");
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://mines.example.test/v1/account");
    expect(request?.headers).toMatchObject({ authorization: "Bearer opaque-session-token" });
    expect(request?.redirect).toBe("error");
    expect(request?.credentials).toBe("omit");
  });

  it("rejects a revoked session on the next identity verification", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ accountId: "account-a" }))
      .mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    const verify = createCatalogIdentityVerifier(controlUrl, fetcher);

    expect(await verify("revocable-session")).toBe("account-a");
    await expect(verify("revocable-session")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["", "local-device", "a".repeat(201)])(
    "rejects an invalid account returned by the service: %s",
    async (accountId) => {
      const verify = createCatalogIdentityVerifier(controlUrl, async () =>
        Response.json({ accountId }),
      );
      await expect(verify("opaque-session-token")).rejects.toThrow();
    },
  );

  it("rejects malformed account responses", async () => {
    const verify = createCatalogIdentityVerifier(controlUrl, async () =>
      Response.json({ userId: "account-a" }),
    );
    await expect(verify("opaque-session-token")).rejects.toThrow();
  });

  it("never sends a session to an insecure account service", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const verify = createCatalogIdentityVerifier("http://mines.example.test", fetcher);

    await expect(verify("opaque-session-token")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
