import type {
  MinesCatalogContext,
  MinesCatalogContextSource,
  MinesCatalogEntity,
  MinesCatalogEntry,
  MinesCatalogSnapshot,
} from "@t3tools/contracts/minesCatalog";

export type CatalogContextOwnerKind = "section" | "project";
export const MAX_CATALOG_CONTEXT_SOURCES = 128;

export interface ResolvedCatalogContextLayer {
  readonly entityId: string;
  readonly kind: CatalogContextOwnerKind;
  readonly title: string;
  readonly instructions: string;
}

export interface ResolvedCatalogContextSource extends MinesCatalogContextSource {
  readonly ownerEntityId: string;
  readonly ownerTitle: string;
  readonly ownerKind: CatalogContextOwnerKind;
}

export interface ResolvedCatalogContext {
  readonly layers: readonly ResolvedCatalogContextLayer[];
  readonly sources: readonly ResolvedCatalogContextSource[];
  readonly unavailableSources: readonly ResolvedCatalogContextSource[];
}

export function normalizeCatalogSourcePath(value: string): string {
  const path = value.trim();
  if (
    !path ||
    path.length > 4_096 ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !/^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/iu.test(path)
  )
    throw new Error("Choose an absolute file or folder path on this computer.");
  return path;
}

export function catalogContextFor(
  snapshot: MinesCatalogSnapshot,
  entityId: string,
): MinesCatalogContext {
  return (
    snapshot.contexts?.find((context) => context.entityId === entityId) ?? {
      entityId,
      instructions: "",
      sources: [],
    }
  );
}

export function resolveCatalogContext(
  snapshot: MinesCatalogSnapshot,
  input: {
    readonly entityId: string;
    readonly environmentId: string;
    readonly fallbackEntityIds?: readonly string[];
  },
): ResolvedCatalogContext {
  const byId = new Map<string, MinesCatalogEntry>();
  const visit = (entries: readonly MinesCatalogEntry[]) => {
    for (const entry of entries) {
      if (byId.has(entry.entity.id)) continue;
      byId.set(entry.entity.id, entry);
      visit(entry.children);
    }
  };
  // Pinned rows are duplicate views and never establish instruction inheritance.
  visit(snapshot.roots);
  const target = [input.entityId, ...(input.fallbackEntityIds ?? [])]
    .map((id) => byId.get(id))
    .find((entry) => entry !== undefined);
  const owners: MinesCatalogEntity[] = [];
  const visited = new Set<string>();
  let entry = target;
  while (entry && !visited.has(entry.entity.id)) {
    visited.add(entry.entity.id);
    if (entry.entity.kind === "section" || entry.entity.kind === "project")
      owners.unshift(entry.entity);
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
  }
  const layers: ResolvedCatalogContextLayer[] = [];
  const sources: ResolvedCatalogContextSource[] = [];
  const unavailableSources: ResolvedCatalogContextSource[] = [];
  const seenSources = new Set<string>();
  for (const owner of owners) {
    if (owner.kind !== "section" && owner.kind !== "project") continue;
    const context = catalogContextFor(snapshot, owner.id);
    layers.push({
      entityId: owner.id,
      kind: owner.kind,
      title: owner.title,
      instructions: context.instructions,
    });
    for (const source of context.sources) {
      const key = JSON.stringify([source.environmentId, source.kind, source.path]);
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      const resolved = {
        ...source,
        ownerEntityId: owner.id,
        ownerTitle: owner.title,
        ownerKind: owner.kind,
      };
      if (source.environmentId === input.environmentId) sources.push(resolved);
      else unavailableSources.push(resolved);
    }
  }
  return { layers, sources, unavailableSources };
}
