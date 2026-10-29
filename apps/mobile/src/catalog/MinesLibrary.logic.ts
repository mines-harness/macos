import type { MinesCatalogEntry, MinesCatalogSnapshot } from "@t3tools/client-runtime/catalog";
export type LibraryRow =
  | {
      key: string;
      entry: MinesCatalogEntry;
      depth: number;
      open: boolean;
      hasChildren: boolean;
      pinned: boolean;
      siblings: readonly MinesCatalogEntry[];
      index: number;
    }
  | { heading: string };

export function buildLibraryRows(
  snapshot: MinesCatalogSnapshot,
  collapsed: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  subagentIds: ReadonlySet<string> = new Set(),
): LibraryRow[] {
  const result: LibraryRow[] = [];
  const pinnedIds = new Set(snapshot.pins.map((entry) => entry.entity.id));
  const visible = (entry: MinesCatalogEntry, pinned: boolean, nestedUnderMine: boolean) =>
    !hidden.has(entry.entity.id) &&
    (pinned || !pinnedIds.has(entry.entity.id)) &&
    (entry.entity.kind !== "thread" ||
      pinned ||
      nestedUnderMine ||
      (entry.entity.importSource?.kind !== "subagent" && !subagentIds.has(entry.entity.id)));
  const append = (
    entries: readonly MinesCatalogEntry[],
    depth: number,
    pinned: boolean,
    path: string,
    nestedUnderMine = false,
  ) => {
    const visibleEntries = entries.filter((entry) => visible(entry, pinned, nestedUnderMine));
    visibleEntries.forEach((entry, index) => {
      const key = `${path}/${encodeURIComponent(entry.entity.id)}`;
      const open = entry.entity.kind === "section" ? !collapsed.has(key) : expanded.has(key);
      const underMine = entry.entity.kind === "thread";
      const hasChildren = entry.children.some((child) => visible(child, false, underMine));
      result.push({
        key,
        entry,
        depth,
        pinned,
        siblings: visibleEntries,
        index,
        open,
        hasChildren,
      });
      if (open) append(entry.children, depth + 1, false, key, underMine);
    });
  };
  result.push({ heading: "Pinned" });
  append(snapshot.pins, 0, true, "pins");
  result.push({ heading: "Library" });
  append(snapshot.roots, 0, false, "library");
  return result;
}
