import {
  canCatalogContain,
  type MinesCatalog,
  type MinesCatalogEntry,
  type MinesCatalogSnapshot,
} from "@t3tools/client-runtime/catalog";

export interface CatalogDragSource {
  readonly entityId: string;
  readonly accountId: string;
}

export interface CatalogDropTarget {
  readonly parentId: string | null;
  readonly beforeId?: string;
  readonly pinned: boolean;
}

function findChildren(
  entries: readonly MinesCatalogEntry[],
  id: string,
): readonly MinesCatalogEntry[] | null {
  for (const entry of entries) {
    if (entry.entity.id === id) return entry.children;
    const found = findChildren(entry.children, id);
    if (found) return found;
  }
  return null;
}

export function catalogDropAllowed(
  snapshot: MinesCatalogSnapshot,
  entityId: string,
  target: CatalogDropTarget,
) {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return false;
  if (!target.pinned) {
    const parent =
      target.parentId === null
        ? null
        : snapshot.entities.find((candidate) => candidate.id === target.parentId);
    if (target.parentId !== null && (!parent || parent.id === entityId)) return false;
    if (!canCatalogContain(parent?.kind ?? null, entity.kind)) return false;
    if (
      parent?.kind === "thread" &&
      !findChildren(snapshot.roots, parent.id)?.some((entry) => entry.entity.id === entityId)
    )
      return false;
  }
  if (target.beforeId) {
    const entries = target.pinned
      ? snapshot.pins
      : target.parentId === null
        ? snapshot.roots
        : findChildren(snapshot.roots, target.parentId);
    if (!entries?.some((entry) => entry.entity.id === target.beforeId)) return false;
  }
  return true;
}

export function commitCatalogDrop(
  catalog: MinesCatalog,
  source: CatalogDragSource,
  target: CatalogDropTarget,
  currentAccountId: string,
) {
  if (source.accountId !== currentAccountId)
    throw new Error("Your account changed. Start this move again.");
  if (!catalogDropAllowed(catalog.getSnapshot(), source.entityId, target))
    throw new Error("This item cannot be placed here. Its destination may have changed.");
  if (target.pinned) catalog.pin(source.entityId, target.beforeId);
  else catalog.move(source.entityId, target.parentId, target.beforeId);
}
