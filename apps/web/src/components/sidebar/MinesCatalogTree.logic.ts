import type { MinesCatalogEntity } from "@t3tools/client-runtime/catalog";

export function isCatalogLibraryEntryVisible(input: {
  readonly entity: MinesCatalogEntity;
  readonly thread?:
    | {
        readonly archivedAt: string | null;
        readonly lineage: { readonly relationshipToParent: "subagent" | "fork" | null };
      }
    | undefined;
  readonly pinned: boolean;
}) {
  if (input.entity.kind !== "thread") return true;
  if (input.thread && input.thread.archivedAt !== null) return false;
  return (
    input.pinned ||
    (input.entity.importSource?.kind !== "subagent" &&
      input.thread?.lineage.relationshipToParent !== "subagent")
  );
}
