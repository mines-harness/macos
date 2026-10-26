import type { AtomRegistry } from "effect/reactivity";
import * as Context from "effect/Context";
import type { MinesCatalog } from "./index.ts";
import { minesAccountIdAtom, minesCatalogIdentityAtom } from "./identity.ts";

interface CatalogExecutionSource {
  readonly accountId: string;
  readonly catalog: MinesCatalog;
  readonly persist: () => Promise<void>;
  users: number;
}
interface CatalogExecutionCapture {
  readonly accountId: string;
  readonly catalog: MinesCatalog;
  readonly stateVector: Uint8Array;
  readonly persist: () => Promise<void>;
  readonly assertCurrent: () => void;
  readonly flushLocal: (environmentId: string, signal: AbortSignal) => Promise<void>;
}
type HostFlush = (capture: CatalogExecutionCapture, signal: AbortSignal) => Promise<void>;
const sources = new WeakMap<AtomRegistry.AtomRegistry, CatalogExecutionSource>();
const hosts = new WeakMap<AtomRegistry.AtomRegistry, Map<string, HostFlush>>();

export function registerCatalogExecutionSource(
  registry: AtomRegistry.AtomRegistry,
  accountId: string,
  catalog: MinesCatalog,
  persist: () => Promise<void>,
): () => void {
  const previous = sources.get(registry);
  const source =
    previous?.accountId === accountId && previous.catalog === catalog
      ? previous
      : { accountId, catalog, persist, users: 0 };
  sources.set(registry, source);
  source.users += 1;
  return () => {
    source.users -= 1;
    if (source.users === 0 && sources.get(registry) === source) sources.delete(registry);
  };
}

export function registerCatalogExecutionHost(
  registry: AtomRegistry.AtomRegistry,
  environmentId: string,
  flush: HostFlush,
): () => void {
  const destinations = hosts.get(registry) ?? new Map<string, HostFlush>();
  hosts.set(registry, destinations);
  destinations.set(environmentId, flush);
  return () => {
    if (destinations.get(environmentId) === flush) destinations.delete(environmentId);
  };
}

export function captureCatalogExecution(
  registry: AtomRegistry.AtomRegistry,
): CatalogExecutionCapture {
  const source = sources.get(registry);
  const accountId = registry.get(minesAccountIdAtom) ?? "local-device";
  const assertCurrent = () => {
    const identity = registry.get(minesCatalogIdentityAtom);
    if (
      !identity.ready ||
      !source ||
      sources.get(registry) !== source ||
      source.accountId !== accountId ||
      (identity.accountId ?? "local-device") !== accountId ||
      (registry.get(minesAccountIdAtom) ?? "local-device") !== accountId
    )
      throw new Error(
        "Your project context is not ready for this account. Wait for synchronization, then send again.",
      );
  };
  assertCurrent();
  if (!source) throw new Error("Your project context has not loaded yet. Try again shortly.");
  const capture: CatalogExecutionCapture = {
    accountId,
    catalog: source.catalog,
    stateVector: source.catalog.encodeStateVector().slice(),
    persist: source.persist,
    assertCurrent,
    flushLocal: async (environmentId, signal) => {
      assertCurrent();
      const flush = hosts.get(registry)?.get(environmentId);
      if (!flush)
        throw new Error(
          "Project context has not connected to this computer. Wait for synchronization, then send again.",
        );
      await flush(capture, signal);
      assertCurrent();
    },
  };
  return capture;
}

/** Installed at the UI command boundary; non-UI callers use the host's authoritative catalog. */
export class RpcCatalogExecution extends Context.Reference<{
  readonly capture: () => CatalogExecutionCapture | null;
}>("@t3tools/client-runtime/catalog/RpcCatalogExecution", {
  defaultValue: () => ({ capture: () => null }),
}) {}

export function catalogBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function catalogBytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
