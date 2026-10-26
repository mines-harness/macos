import { describe, expect, it, vi } from "vite-plus/test";

import { createMinesAccountClient, MinesAccountError } from "./minesAccountClient";

const user = {
  id: "account-1",
  name: "Mines user",
  email: "user@example.com",
  emailVerified: false,
};

describe("self-hosted Mines accounts", () => {
  it("reads bearer sessions without sending cookies or following a redirect", async () => {
    const fetchAccount = vi.fn().mockResolvedValue(Response.json({ session: {}, user }));
    const client = createMinesAccountClient("https://mines.example.com", fetchAccount);
    expect(await client.getSession("private-token")).toEqual(user);
    expect(fetchAccount).toHaveBeenCalledWith(
      "https://mines.example.com/api/auth/get-session",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer private-token" }),
      }),
    );
  });

  it("accepts a bearer token exposed in a response header", async () => {
    const fetchAccount = vi
      .fn()
      .mockResolvedValue(
        Response.json({ user }, { headers: { "set-auth-token": "account-token" } }),
      );
    const client = createMinesAccountClient("https://mines.example.com", fetchAccount);
    await expect(
      client.signIn({ email: user.email, password: "a long password" }),
    ).resolves.toEqual({
      user,
      token: "account-token",
    });
  });

  it("keeps verification-required sign-ups signed out", async () => {
    const fetchAccount = vi.fn().mockResolvedValue(Response.json({ user, token: null }));
    const client = createMinesAccountClient("https://mines.example.com", fetchAccount);
    await expect(
      client.signUp({ name: user.name, email: user.email, password: "a long password" }),
    ).resolves.toEqual({ user, token: null });
    expect(JSON.parse(fetchAccount.mock.calls[0]![1].body)).toMatchObject({
      callbackURL: "https://mines.example.com/account-verified",
    });
  });

  it("rejects the unsigned JSON token when the signed bearer header is missing", async () => {
    const client = createMinesAccountClient(
      "https://mines.example.com",
      vi.fn().mockResolvedValue(Response.json({ user, token: "unsigned-session-token" })),
    );
    await expect(client.signIn({ email: user.email, password: "a long password" })).rejects.toThrow(
      "The account service returned an incomplete session. Please try signing in again.",
    );
  });

  it("clears expired sessions and reports verification errors distinctly", async () => {
    const client = createMinesAccountClient(
      "https://mines.example.com",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: "Unauthorized" }, { status: 401 }))
        .mockResolvedValueOnce(
          Response.json(
            { code: "EMAIL_NOT_VERIFIED", message: "internal detail" },
            { status: 403 },
          ),
        ),
    );
    await expect(client.getSession("expired-token")).resolves.toBeNull();
    await expect(client.signIn({ email: user.email, password: "a long password" })).rejects.toEqual(
      expect.objectContaining({
        code: "EMAIL_NOT_VERIFIED",
        message: "Verify your email before signing in. You can request a new email below.",
      }),
    );
  });

  it("uses the hosted account page for recovery and revokes the current bearer on sign-out", async () => {
    const fetchAccount = vi.fn().mockImplementation(async () => Response.json({ success: true }));
    const client = createMinesAccountClient("https://mines.example.com", fetchAccount);
    await client.requestPasswordReset(user.email);
    expect(JSON.parse(fetchAccount.mock.calls[0]![1].body)).toEqual({
      email: user.email,
      redirectTo: "https://mines.example.com/reset-password",
    });
    await client.signOut("private-token");
    expect(fetchAccount.mock.calls[1]![1].headers.Authorization).toBe("Bearer private-token");
  });

  it("reports a connection failure without exposing transport details", async () => {
    const client = createMinesAccountClient(
      "https://mines.example.com",
      vi.fn().mockRejectedValue(new TypeError("private network detail")),
    );
    await expect(client.getSession("private-token")).rejects.toBeInstanceOf(MinesAccountError);
    await expect(client.getSession("private-token")).rejects.toThrow(
      "Cannot reach the Mines account service. Check your connection and try again.",
    );
  });
});
