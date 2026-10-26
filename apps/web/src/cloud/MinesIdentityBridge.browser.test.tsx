import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
  minesCatalogIdentityAtom,
} from "@t3tools/client-runtime/catalog";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  accountId: null as string | null,
  clear: vi.fn(),
  bind: vi.fn(),
  configure: vi.fn(),
  hosts: [] as Array<{ id: string; httpBaseUrl: string; peerSession?: object }>,
  getToken: vi.fn(),
  loaded: true,
}));
vi.mock("./MinesAuthProvider", () => ({
  useMinesAuth: () => ({
    isLoaded: state.loaded,
    isSignedIn: state.accountId !== null,
    userId: state.accountId,
    getToken: state.getToken,
  }),
}));
vi.mock("../connection/peerOnboarding", () => ({ restorePeerClient: {} }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.hosts.map((host) => ({
      environmentId: host.id,
      connection: { phase: "connected" },
    })),
  }),
}));
vi.mock("../state/session", () => ({
  readPreparedConnection: (id: string) => state.hosts.find((host) => host.id === id) ?? null,
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(state.hosts.map((host) => host.id)),
}));
vi.mock("../state/catalogIdentity", () => ({ bindCatalogIdentity: { kind: "bind" } }));
vi.mock("../state/peers", () => ({ peerConfigure: { kind: "configure" } }));
vi.mock("./publicConfig", () => ({ minesControlUrl: () => "https://account.example.com" }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (...args: unknown[]) => {
    const command = args[1] as { kind?: string };
    if (command.kind === "bind") return state.bind(args[2]);
    if (command.kind === "configure") return state.configure(args[2]);
    return state.clear(...args);
  },
  squashAtomCommandFailure: () => new Error("Account transition failed"),
}));

import { MinesIdentityBridge } from "./MinesIdentityBridge";

function setup() {
  state.accountId = null;
  state.loaded = true;
  state.hosts = [];
  state.getToken.mockReset().mockResolvedValue("verified-account-token");
  state.clear.mockReset().mockResolvedValue(AsyncResult.success([]));
  state.bind
    .mockReset()
    .mockImplementation(({ input }: { input: { bearerToken: string | null } }) =>
      Promise.resolve(
        AsyncResult.success({ accountId: input.bearerToken ? state.accountId : null }),
      ),
    );
  state.configure.mockReset().mockResolvedValue(AsyncResult.success({}));
  appAtomRegistry.set(minesAccountIdAtom, null);
  appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set());
  appAtomRegistry.set(minesCatalogIdentityAtom, { ready: false, accountId: null, readToken: null });
}
function completion() {
  let resolve!: (result: ReturnType<typeof AsyncResult.success<ReadonlyArray<string>>>) => void;
  const promise = new Promise<ReturnType<typeof AsyncResult.success<ReadonlyArray<string>>>>(
    (complete) => {
      resolve = complete;
    },
  );
  return { promise, resolve };
}

describe("mines identity without a relay session", () => {
  it("withholds the new catalog identity until previous direct sessions are closed", async () => {
    setup();
    const cleared = completion();
    state.accountId = "account-a";
    appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set(["previous-account-device"]));
    state.clear.mockReturnValueOnce(cleared.promise);
    // The identity boundary has no navigation or route dependencies.
    await using screen = await render(<MinesIdentityBridge>Private library</MinesIdentityBridge>, {
      router: false,
    });
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
    expect(appAtomRegistry.get(minesCatalogIdentityAtom).ready).toBe(false);
    expect(appAtomRegistry.get(minesAccountEnvironmentIdsAtom).size).toBe(0);
    await act(() => cleared.resolve(AsyncResult.success(["account-a-device"])));
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBe("account-a");
    const identity = appAtomRegistry.get(minesCatalogIdentityAtom);
    expect(identity.ready).toBe(true);
    expect(identity.accountId).toBe("account-a");
    expect(await identity.readToken?.()).toBe("verified-account-token");
    expect([...appAtomRegistry.get(minesAccountEnvironmentIdsAtom)]).toEqual(["account-a-device"]);

    state.accountId = null;
    await screen.rerender(<MinesIdentityBridge>Signed out</MinesIdentityBridge>);
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
    expect(appAtomRegistry.get(minesAccountEnvironmentIdsAtom).size).toBe(0);
    expect(appAtomRegistry.get(minesCatalogIdentityAtom).readToken).toBeNull();
  });

  it("does not let a late cleanup result republish an account after switching", async () => {
    setup();
    const first = completion();
    const second = completion();
    state.accountId = "account-a";
    state.clear.mockReturnValueOnce(first.promise);
    // The identity boundary has no navigation or route dependencies.
    await using screen = await render(<MinesIdentityBridge>Library A</MinesIdentityBridge>, {
      router: false,
    });
    state.accountId = "account-b";
    state.clear.mockResolvedValueOnce(AsyncResult.success([])).mockReturnValueOnce(second.promise);
    await screen.rerender(<MinesIdentityBridge>Library B</MinesIdentityBridge>);
    await act(() => first.resolve(AsyncResult.success(["account-a-device"])));
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
    expect(appAtomRegistry.get(minesAccountEnvironmentIdsAtom).size).toBe(0);
    await act(() => second.resolve(AsyncResult.success(["account-b-device"])));
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBe("account-b");
    expect([...appAtomRegistry.get(minesAccountEnvironmentIdsAtom)]).toEqual(["account-b-device"]);
    await screen.unmount();
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
    expect(appAtomRegistry.get(minesAccountEnvironmentIdsAtom).size).toBe(0);
  });

  it("keeps private catalogs unavailable when direct-session cleanup fails", async () => {
    setup();
    state.accountId = "account-a";
    state.clear.mockResolvedValue(AsyncResult.failure(Cause.die("cleanup failed")));
    // The identity boundary has no navigation or route dependencies.
    await using _screen = await render(<MinesIdentityBridge>Private library</MinesIdentityBridge>, {
      router: false,
    });
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
  });

  it("registers only local hosts and tears down every reachable host when another cannot sign out", async () => {
    setup();
    state.accountId = "account-a";
    state.hosts = [
      { id: "local-a", httpBaseUrl: "http://127.0.0.1:3773" },
      { id: "local-b", httpBaseUrl: "http://localhost:3774" },
      { id: "remote", httpBaseUrl: "https://remote.example.com" },
      { id: "peer", httpBaseUrl: "http://localhost:3775", peerSession: {} },
    ];
    // The identity boundary has no navigation or route dependencies.
    await using screen = await render(<MinesIdentityBridge>Account library</MinesIdentityBridge>, {
      router: false,
    });
    await vi.waitFor(() => expect(state.configure).toHaveBeenCalledTimes(2));
    expect(state.configure.mock.calls.map(([value]) => value.environmentId)).toEqual([
      "local-a",
      "local-b",
    ]);
    expect(
      state.configure.mock.calls.every(
        ([value]) => value.input.bearerToken === "verified-account-token",
      ),
    ).toBe(true);
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBe("account-a");

    state.bind
      .mockReset()
      .mockImplementation(({ environmentId }: { environmentId: string }) =>
        Promise.resolve(
          environmentId === "local-a"
            ? AsyncResult.failure(Cause.die("unavailable"))
            : AsyncResult.success({ accountId: null }),
        ),
      );
    state.clear.mockClear();
    state.accountId = null;
    await screen.rerender(<MinesIdentityBridge>Signed out</MinesIdentityBridge>);
    await vi.waitFor(() =>
      expect(state.bind).toHaveBeenCalledWith({
        environmentId: "local-b",
        input: { bearerToken: null },
      }),
    );
    await vi.waitFor(() =>
      expect(state.clear.mock.calls.some((args) => args[2] === null)).toBe(true),
    );
    expect(appAtomRegistry.get(minesAccountIdAtom)).toBeNull();
    expect(appAtomRegistry.get(minesCatalogIdentityAtom).ready).toBe(false);
  });
});
