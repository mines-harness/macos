import { Atom } from "effect/reactivity";

interface MinesCatalogIdentity {
  readonly ready: boolean;
  readonly accountId: string | null;
  readonly readToken: (() => Promise<string | null>) | null;
}

export const minesCatalogIdentityAtom = Atom.make<MinesCatalogIdentity>({
  ready: true,
  accountId: null,
  readToken: null,
}).pipe(Atom.keepAlive, Atom.withLabel("mines:catalog-identity"));

/** System identity is independent of the optional legacy relay session. */
export const minesAccountIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mines:account-id"),
);

/** Remote environments restored from the current account's pinned device routes. */
export const minesAccountEnvironmentIdsAtom = Atom.make<ReadonlySet<string>>(
  new Set<string>(),
).pipe(Atom.keepAlive, Atom.withLabel("mines:account-environments"));
