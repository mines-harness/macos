import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { MinesAuthProvider, useMinesAuth } from "./MinesAuthProvider";

vi.mock("./publicConfig", () => ({ minesControlUrl: () => "https://account.example.com" }));
vi.mock("../components/account/MinesAccountDialog", () => ({ MinesAccountDialog: () => null }));

const user = { id: "account-a", name: "Account A", email: "a@example.com", emailVerified: true };
const storageKey = "mines.account.session:https://account.example.com";

function Harness() {
  const auth = useMinesAuth();
  return (
    <div>
      <p role="status">{auth.isLoaded ? (auth.user?.email ?? "Signed out") : "Loading"}</p>
      <button
        onClick={() =>
          void auth.signIn({ email: user.email, password: "long test password" }).catch(() => {})
        }
      >
        Sign in
      </button>
      <button onClick={() => void auth.signOut().catch(() => {})}>Sign out</button>
    </div>
  );
}

function responseGate() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Mines account session lifecycle", () => {
  it("does not restore a sign-in that finishes after sign-out", async () => {
    localStorage.removeItem(storageKey);
    const response = responseGate();
    using _fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    // The account lifecycle has no routing dependencies.
    await using screen = await render(
      <MinesAuthProvider>
        <Harness />
      </MinesAuthProvider>,
      { router: false },
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Signed out");
    await userEvent.click(screen.getByRole("button", { name: "Sign in", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await act(() =>
      response.resolve(Response.json({ user }, { headers: { "set-auth-token": "signed-token" } })),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Signed out");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("clears local identity and credentials when the server is unavailable during sign-out", async () => {
    localStorage.setItem(storageKey, "signed-token");
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ user, session: {} }))
      .mockRejectedValue(new TypeError("network unavailable"));
    // The account lifecycle has no routing dependencies.
    await using screen = await render(
      <MinesAuthProvider>
        <Harness />
      </MinesAuthProvider>,
      { router: false },
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent(user.email);
    await userEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Signed out");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
