import { expect, it } from "vite-plus/test";
import { isCatalogLibraryEntryVisible } from "./MinesCatalogTree.logic";

const mine = { id: "mine", kind: "thread" as const, title: "Mine" };

it("keeps imported agent histories out of the default library even without a loaded shell", () => {
  const entity = {
    ...mine,
    importSource: { executionProjectId: "execution", kind: "subagent" as const },
  };
  expect(isCatalogLibraryEntryVisible({ entity, pinned: false })).toBe(false);
  expect(isCatalogLibraryEntryVisible({ entity, pinned: true })).toBe(true);
});

it("hides known native agents while keeping regular and forked mines visible", () => {
  for (const relationshipToParent of ["subagent", "fork", null] as const)
    expect(
      isCatalogLibraryEntryVisible({
        entity: mine,
        pinned: false,
        thread: { archivedAt: null, lineage: { relationshipToParent } },
      }),
    ).toBe(relationshipToParent !== "subagent");
});

it("retains the archive filter for explicitly pinned agents", () => {
  expect(
    isCatalogLibraryEntryVisible({
      entity: mine,
      pinned: true,
      thread: { archivedAt: "2026-10-26T00:00:00Z", lineage: { relationshipToParent: "subagent" } },
    }),
  ).toBe(false);
});
