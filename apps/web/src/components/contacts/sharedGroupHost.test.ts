import {
  minesAccountEnvironmentIdsAtom,
  minesAccountIdAtom,
} from "@t3tools/client-runtime/catalog";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { checkSharedGroupHost } from "./sharedGroupHost";

const environmentId = EnvironmentId.make("my-computer");
const connection = {
  configured: true,
  online: true,
  controlUrl: "https://contacts.example.test",
  accountId: "alice",
  stunServers: [],
  failure: null,
};
function setup() {
  const account = appAtomRegistry.get(minesAccountIdAtom);
  const owned = appAtomRegistry.get(minesAccountEnvironmentIdsAtom);
  appAtomRegistry.set(minesAccountIdAtom, "alice");
  appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set([environmentId]));
  return {
    [Symbol.dispose]() {
      appAtomRegistry.set(minesAccountIdAtom, account);
      appAtomRegistry.set(minesAccountEnvironmentIdsAtom, owned);
    },
  };
}
it("requires an owned computer and its freshly confirmed matching account", async () => {
  using _scope = setup();
  const load = vi.fn(async () => AsyncResult.success(connection));
  await expect(checkSharedGroupHost(environmentId, "alice", load)).resolves.toBeUndefined();
  await expect(
    checkSharedGroupHost(EnvironmentId.make("someone-else"), "alice", load),
  ).rejects.toThrow("current mines account");
  expect(load).toHaveBeenCalledTimes(1);
});
it("rejects a switched account after the host check finishes", async () => {
  using _scope = setup();
  const load = async () => {
    appAtomRegistry.set(minesAccountIdAtom, "bob");
    return AsyncResult.success(connection);
  };
  await expect(checkSharedGroupHost(environmentId, "alice", load)).rejects.toThrow(
    "current mines account",
  );
});
it("rejects an old peer account instead of sending as that friend identity", async () => {
  using _scope = setup();
  await expect(
    checkSharedGroupHost(environmentId, "alice", async () =>
      AsyncResult.success({ ...connection, accountId: "bob" }),
    ),
  ).rejects.toThrow("before sharing groups");
});
