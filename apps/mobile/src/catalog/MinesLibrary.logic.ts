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
): LibraryRow[] {
  const result: LibraryRow[] = [];
  const append = (
    entries: readonly MinesCatalogEntry[],
    depth: number,
    pinned: boolean,
    path: string,
  ) => {
    const visible = entries.filter((entry) => !hidden.has(entry.entity.id));
    visible.forEach((entry, index) => {
      const key = `${path}/${encodeURIComponent(entry.entity.id)}`;
      const open =
        entry.entity.kind === "section" || entry.entity.kind === "thread"
          ? !collapsed.has(key)
          : expanded.has(key);
      const hasChildren = entry.children.some((child) => !hidden.has(child.entity.id));
      result.push({ key, entry, depth, pinned, siblings: visible, index, open, hasChildren });
      if (open) append(entry.children, depth + 1, false, key);
    });
  };
  result.push({ heading: "Pinned" });
  append(snapshot.pins, 0, true, "pins");
  result.push({ heading: "Library" });
  append(snapshot.roots, 0, false, "library");
  return result;
}
