import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AuthAccessReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  type EnvironmentConnectionPhase,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";

import { buildDeviceList } from "../components/settings/deviceList.logic";

type Presentation = Pick<EnvironmentPresentation, "entry" | "connection">;
type PeerState = { readonly device: PeerDevice; readonly approvedDevices: readonly PeerDevice[] };
const state = vi.hoisted(() => ({
  account: undefined as unknown as Atom.Writable<string | null>,
  boundAccount: undefined as unknown as Atom.Writable<string | null>,
  presentations: undefined as unknown as Atom.Writable<ReadonlyMap<EnvironmentId, Presentation>>,
  sessions: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<AuthSessionState, Error>>
  >(),
  peers: new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<PeerState, Error>>>(),
  identityPeers: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PeerState, Error>>>(),
  queried: new Set<EnvironmentId>(),
  requests: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/catalog", () => ({
  get minesAccountIdAtom() {
    return state.boundAccount;
  },
}));
vi.mock("./catalogIdentity", () => ({
  get peerDeviceAccountIdAtom() {
    return state.account;
  },
}));
vi.mock("./presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return state.presentations;
    },
  },
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)! },
}));
vi.mock("./peers", () => ({
  peerIdentityState:
    (key: string) =>
    ({ environmentId }: { readonly environmentId: EnvironmentId }) => {
      state.requests(environmentId);
      let result = state.identityPeers.get(key);
      if (!result) {
        result = state.queried.has(environmentId)
          ? Atom.make<AsyncResult.AsyncResult<PeerState, Error>>(AsyncResult.initial())
          : state.peers.get(environmentId)!;
        state.queried.add(environmentId);
        state.identityPeers.set(key, result);
      }
      return result;
    },
}));

import { environmentPeerDevicesAtom } from "./environmentPeerDevices";

const firstId = EnvironmentId.make("first");
const secondId = EnvironmentId.make("second");
const device = createPeerIdentity(new Uint8Array(32).fill(7), "mind").device;
const granted: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthAccessReadScope],
  permissions: [AuthAccessReadScope],
};
function presentation(phase: EnvironmentConnectionPhase, hostname = "mind.example.test") {
  const connectionId = "ssh:mind";
  return {
    entry: {
      target: new SshConnectionTarget({ environmentId: firstId, label: "mind", connectionId }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId: firstId,
          connectionId,
          label: "mind",
          target: { alias: "mind", hostname, username: "debian", port: 22 },
        }),
      ),
      enabled: true,
    },
    connection: { phase, error: null, traceId: null },
  };
}
function fixture() {
  state.requests.mockClear();
  state.account = Atom.make<string | null>("account-a");
  state.boundAccount = Atom.make<string | null>("account-a");
  const presentations: ReadonlyMap<EnvironmentId, Presentation> = new Map([
    [firstId, presentation("connected")],
  ]);
  state.presentations = Atom.make(presentations);
  state.sessions.clear();
  state.peers.clear();
  state.identityPeers.clear();
  state.queried.clear();
  for (const id of [firstId, secondId]) {
    state.sessions.set(
      id,
      Atom.make<AsyncResult.AsyncResult<AuthSessionState, Error>>(AsyncResult.success(granted)),
    );
    state.peers.set(
      id,
      Atom.make<AsyncResult.AsyncResult<PeerState, Error>>(
        AsyncResult.success({ device, approvedDevices: [] }),
      ),
    );
  }
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const unmount = registry.mount(environmentPeerDevicesAtom);
  return {
    registry,
    unmount,
    flush: () => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
    },
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("environment peer identities", () => {
  it("reads only connected environments with the destination access grant", () => {
    using f = fixture();
    f.registry.set(
      state.presentations,
      new Map([
        [firstId, presentation("connected")],
        [secondId, presentation("offline")],
      ]),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    expect(state.requests.mock.calls.flat()).not.toContain(secondId);
    state.requests.mockClear();
    f.registry.set(
      state.sessions.get(firstId)!,
      AsyncResult.success({
        ...granted,
        permissions: [],
        scopes: [],
      }),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("retains known offline identities and prunes removed environments", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    state.requests.mockClear();
    f.registry.set(state.presentations, new Map([[firstId, presentation("offline")]]));
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    expect(state.requests).not.toHaveBeenCalled();
    f.registry.set(state.presentations, new Map());
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
  });

  it("does not retain identities across account changes or explicit access revocation", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    f.registry.set(state.presentations, new Map([[firstId, presentation("offline")]]));
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(1);
    f.registry.set(state.account, "account-b");
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    f.registry.set(state.boundAccount, "account-b");
    f.registry.set(state.presentations, new Map([[firstId, presentation("connected")]]));
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    f.registry.set(
      [...state.identityPeers.values()].at(-1)!,
      AsyncResult.success({ device, approvedDevices: [] }),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(1);
    f.registry.set(state.presentations, new Map([[firstId, presentation("offline")]]));
    f.registry.set(
      state.sessions.get(firstId)!,
      AsyncResult.success({ ...granted, permissions: [], scopes: [] }),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
  });

  it("keeps a known SSH device paired through transient retry errors and Settings remounts", () => {
    using f = fixture();
    const other = createPeerIdentity(new Uint8Array(32).fill(8), "mind").device;
    const rows = () =>
      buildDeviceList({
        environments: [
          {
            environmentId: firstId,
            label: "mind",
            ...f.registry.get(state.presentations).get(firstId)!,
          },
        ],
        environmentDevices: f.registry.get(environmentPeerDevicesAtom),
        directory: { devices: [device, other] },
      });
    expect(rows()).toHaveLength(2);
    state.requests.mockClear();
    f.registry.set(state.presentations, new Map([[firstId, presentation("reconnecting")]]));
    f.registry.set(state.sessions.get(firstId)!, AsyncResult.initial(true));
    expect(rows()).toHaveLength(2);
    f.registry.set(state.sessions.get(firstId)!, AsyncResult.fail(new Error("Transport closed")));
    expect(rows()).toHaveLength(2);
    f.registry.set(state.boundAccount, null);
    expect(rows()).toHaveLength(2);
    f.registry.set(state.boundAccount, "account-a");
    expect(rows()).toHaveLength(2);
    f.unmount();
    f.flush();
    f.registry.mount(environmentPeerDevicesAtom);
    expect(rows()).toEqual([
      expect.objectContaining({ environmentId: firstId, accountDeviceId: device.deviceId }),
      expect.objectContaining({ accountDeviceId: other.deviceId, status: "needs-approval" }),
    ]);
    f.registry.set(state.sessions.get(firstId)!, AsyncResult.success({ ...granted }));
    expect(rows()).toHaveLength(2);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("drops a remembered identity when the same environment's SSH route is replaced", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    state.requests.mockClear();
    f.registry.set(state.sessions.get(firstId)!, AsyncResult.initial(true));
    f.registry.set(
      state.presentations,
      new Map([[firstId, presentation("reconnecting", "replacement.example.test")]]),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("requires a fresh peer result after replacing a connected SSH route", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    f.registry.set(
      state.presentations,
      new Map([[firstId, presentation("connected", "replacement.example.test")]]),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    const replacement = createPeerIdentity(new Uint8Array(32).fill(9), "mind").device;
    f.registry.set(
      [...state.identityPeers.values()].at(-1)!,
      AsyncResult.success({ device: replacement, approvedDevices: [] }),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(replacement);
  });
});
