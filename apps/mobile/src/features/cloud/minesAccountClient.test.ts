import { describe, expect, it, vi } from "vite-plus/test";

import { createMinesAccountClient } from "./minesAccountClient";

const user = { id: "account-a", email: "pilot@example.test", name: "Pilot", emailVerified: true };

function setup(responses: Response[], stored: string | null = null) {
  let token = stored;
  const storage = {
    getItem: vi.fn(async () => token),
    setItem: vi.fn(async (_key: string, value: string) => {
      token = value;
    }),
    removeItem: vi.fn(async () => {
      token = null;
    }),
  };
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  return {
    client: createMinesAccountClient("https://mines.example.test", storage, fetcher),
    storage,
    fetcher,
  };
}

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });

describe("Mines native account sessions", () => {
  it("stores the signed bearer header from sign-in and restores only the verified account", async () => {
    const { client, storage, fetcher } = setup([
      json({ token: "raw-token", user }, 200, { "set-auth-token": "signed-token" }),
      json({ session: { id: "session-a" }, user }),
    ]);
    expect(await client.signIn("pilot@example.test", "long-password")).toEqual({
      token: "signed-token",
      user,
    });
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), "signed-token");
    expect(await client.restore()).toEqual({ token: "signed-token", user });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://mines.example.test/api/auth/get-session",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer signed-token" }),
      }),
    );
  });

  it("never activates or persists an unverified signup", async () => {
    const { client, storage } = setup([
      json({ token: null, user: { ...user, emailVerified: false } }),
    ]);
    await client.signUp("Pilot", "pilot@example.test", "long-password");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("requires the signed bearer header instead of the raw JSON token", async () => {
    const { client, storage } = setup([json({ token: "unsigned-token", user })]);
    await expect(client.signIn("pilot@example.test", "long-password")).rejects.toThrow(
      "did not return a session",
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("supports a self-hosted server that explicitly disables mail verification", async () => {
    const { client } = setup([
      json({ emailVerificationRequired: false, passwordResetEnabled: false }),
      json({ user: { ...user, emailVerified: false } }, 200, { "set-auth-token": "signed-token" }),
    ]);
    expect(await client.getConfiguration()).toEqual({
      emailVerificationRequired: false,
      passwordResetEnabled: false,
    });
    expect((await client.signIn("pilot@example.test", "long-password")).user.emailVerified).toBe(
      false,
    );
  });

  it("clears a stored expired session", async () => {
    const { client, storage } = setup([json(null)], "expired-token");
    expect(await client.restore()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalled();
  });

  it("clears a rejected stored bearer", async () => {
    const { client, storage } = setup([json({ message: "Invalid session" }, 401)], "expired-token");
    expect(await client.restore()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalled();
  });

  it("rejects a session for an unverified email", async () => {
    const { client, storage } = setup(
      [json({ session: { id: "session-a" }, user: { ...user, emailVerified: false } })],
      "old-token",
    );
    expect(await client.restore()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalled();
  });

  it("removes the local credential even when remote sign-out fails", async () => {
    const { client, storage, fetcher } = setup(
      [json({ message: "Unavailable" }, 503)],
      "signed-token",
    );
    await expect(client.signOut("signed-token")).rejects.toThrow("Unavailable");
    expect(storage.removeItem).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      "https://mines.example.test/api/auth/sign-out",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer signed-token" }),
      }),
    );
  });

  it("preserves a saved credential on a temporary restore failure", async () => {
    const { client, storage } = setup([json({ message: "Unavailable" }, 503)], "signed-token");
    await expect(client.restore()).rejects.toThrow("Unavailable");
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("does not save a sign-in response that arrives after sign-out", async () => {
    const pending = Promise.withResolvers<Response>();
    const { client, storage, fetcher } = setup([]);
    fetcher.mockImplementationOnce(() => pending.promise);
    const signIn = client.signIn("pilot@example.test", "long-password");
    await client.signOut(null);
    pending.resolve(
      json({ token: "late-token", user }, 200, { "set-auth-token": "late-signed-token" }),
    );
    await expect(signIn).rejects.toThrow("cancelled");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not clear a new sign-in when an older restore expires", async () => {
    const requested = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const { client, storage, fetcher } = setup(
      [json({ token: "raw-token", user }, 200, { "set-auth-token": "new-token" })],
      "old-token",
    );
    fetcher.mockImplementationOnce(() => {
      requested.resolve();
      return pending.promise;
    });
    const restore = client.restore();
    await requested.promise;
    await client.signIn("pilot@example.test", "long-password");
    pending.resolve(json(null));
    await restore;
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), "new-token");
  });
});
