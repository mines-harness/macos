import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import type { PeerConnectionState } from "@t3tools/contracts/minesPeer";
import { checkSharedGroupHost } from "./sharedGroupHost";

const state = vi.hoisted(() => ({ accountId: "current", owned: new Set(["local"]) }));
vi.mock("@t3tools/client-runtime/catalog", () => ({
  minesAccountIdAtom: "account",
  minesAccountEnvironmentIdsAtom: "owned",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: (atom: unknown) => (atom === "account" ? state.accountId : state.owned) },
}));
const local = EnvironmentId.make("local");
const current: PeerConnectionState = {
  configured: true,
  online: true,
  accountId: "current",
  controlUrl: "https://control.example",
  stunServers: [],
  failure: null,
};
function setup() {
  state.accountId = "current";
  state.owned = new Set(["local"]);
}

describe("shared group computer account boundary", () => {
  it("rejects a connected computer still configured for another account", async () => {
    setup();
    await expect(
      checkSharedGroupHost(local, "current", async () =>
        AsyncResult.success({ ...current, accountId: "previous" }),
      ),
    ).rejects.toThrow("current mines account");
  });
  it("rejects an account change while the computer check is pending", async () => {
    setup();
    const result = Promise.withResolvers<AtomCommandResult<PeerConnectionState, unknown>>();
    const checked = checkSharedGroupHost(local, "current", () => result.promise);
    state.accountId = "next";
    result.resolve(AsyncResult.success(current));
    await expect(checked).rejects.toThrow("current mines account");
  });
  it("does not query a computer outside the current account", async () => {
    setup();
    state.owned = new Set();
    const load = vi.fn(async () => AsyncResult.success(current));
    await expect(checkSharedGroupHost(local, "current", load)).rejects.toThrow(
      "current mines account",
    );
    expect(load).not.toHaveBeenCalled();
  });
});
