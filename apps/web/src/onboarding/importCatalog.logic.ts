import {
  catalogHostId,
  type MinesCatalog,
  type MinesCatalogEntry,
} from "@t3tools/client-runtime/catalog";
import {
  isAgentSessionGeneratedContextTitle,
  type AgentSessionImportResult,
  type AgentSessionSourceSection,
  type AgentSessionSourceProject,
} from "@t3tools/contracts";

function findEntry(
  entries: readonly MinesCatalogEntry[],
  id: string,
): MinesCatalogEntry | undefined {
  for (const entry of entries) {
    if (entry.entity.id === id) return entry;
    const found = findEntry(entry.children, id);
    if (found) return found;
  }
  return undefined;
}

export function applyImportedCatalog(
  catalog: MinesCatalog,
  input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly title: string;
    readonly sourceSection?: AgentSessionSourceSection | undefined;
    readonly sourceProject?: AgentSessionSourceProject | null | undefined;
  },
  threads: NonNullable<AgentSessionImportResult["catalogThreads"]> = [],
) {
  const projectId = catalogHostId("project", input.environmentId, input.projectId);
  const initialRoots = catalog.getSnapshot().roots;
  const executionOnly =
    input.sourceProject !== undefined ||
    (threads.length > 0 && threads.every((thread) => thread.sourceProject !== undefined));
  const sectionId = (section: AgentSessionSourceSection) => {
    const id = `imported-section:${JSON.stringify([input.environmentId, section.id])}`;
    if (!catalog.has(id)) catalog.upsert({ id, kind: "section", title: section.title });
    return catalog.has(id) ? id : null;
  };
  const sourceProjectFor = (thread: (typeof threads)[number]) =>
    thread.sourceProject === undefined ? input.sourceProject : thread.sourceProject;
  const sourceProjectId = (source: AgentSessionSourceProject) =>
    `imported-project:${JSON.stringify([input.environmentId, source.id])}`;
  catalog.transaction(() => {
    const previous = findEntry(initialRoots, projectId)?.entity;
    catalog.upsert({
      ...previous,
      id: projectId,
      kind: "project",
      title: previous?.title ?? input.title,
      hostRef: { environmentId: input.environmentId, entityId: input.projectId },
      ...(executionOnly
        ? { importSource: { executionProjectId: input.projectId, sourceProject: null } }
        : {}),
    });
    if (!executionOnly && input.sourceSection && catalog.has(projectId)) {
      const destination = sectionId(input.sourceSection);
      const existing = findEntry(initialRoots, projectId);
      if (destination !== null && (!existing || existing.parentId === null))
        catalog.move(projectId, destination);
    }
    for (const thread of threads) {
      const id = catalogHostId("thread", input.environmentId, thread.threadId);
      const current = findEntry(initialRoots, id)?.entity;
      const {
        threadId: _id,
        title: _title,
        sourceSection: _section,
        parentThreadId: _parent,
        rootThreadId: _root,
        ...provenance
      } = thread;
      const sourceProject = sourceProjectFor(thread);
      const repairTitle =
        current &&
        thread.threadId.startsWith("import:") &&
        isAgentSessionGeneratedContextTitle(current.title) &&
        !isAgentSessionGeneratedContextTitle(thread.title);
      const title = current && !repairTitle ? current.title : thread.title;
      catalog.upsert({
        ...current,
        id,
        kind: "thread",
        title,
        hostRef: { environmentId: input.environmentId, entityId: thread.threadId },
        importSource: {
          ...current?.importSource,
          ...provenance,
          executionProjectId: input.projectId,
          ...(sourceProject === undefined ? {} : { sourceProject }),
        },
      });
      if (sourceProject) {
        const logicalId = sourceProjectId(sourceProject);
        const existing = findEntry(initialRoots, logicalId)?.entity;
        catalog.upsert({
          ...existing,
          id: logicalId,
          kind: "project",
          title: existing?.title ?? sourceProject.title,
          hostRef: { environmentId: input.environmentId, entityId: input.projectId },
          importSource: { executionProjectId: input.projectId, sourceProject },
        });
      }
    }
  });
  // Placement reads the committed snapshot so children may precede their parents in an import page.
  const roots = catalog.getSnapshot().roots;
  catalog.transaction(() => {
    for (const thread of threads) {
      const id = catalogHostId("thread", input.environmentId, thread.threadId);
      if (!catalog.has(id)) continue;
      const existing = findEntry(initialRoots, id);
      const sourceProject = sourceProjectFor(thread);
      const sourceSection =
        thread.sourceSection ?? (sourceProject !== undefined ? input.sourceSection : undefined);
      const section = sourceSection ? sectionId(sourceSection) : null;
      let destination: string | null = sourceProject === null ? section : projectId;
      if (sourceProject) {
        const logical = sourceProjectId(sourceProject);
        if (catalog.has(logical)) {
          const placed = findEntry(roots, logical);
          if (section !== null && (!findEntry(initialRoots, logical) || placed?.parentId === null))
            catalog.move(logical, section);
          destination = logical;
        }
      } else if (sourceProject === undefined && thread.sourceSection) destination = section;
      const parent = thread.parentThreadId
        ? catalogHostId("thread", input.environmentId, thread.parentThreadId)
        : null;
      if (thread.kind === "subagent" && parent && catalog.has(parent) && parent !== id)
        destination = parent;
      const oldSection = sourceSection
        ? `imported-section:${JSON.stringify([input.environmentId, sourceSection.id])}`
        : null;
      const automatic =
        !existing ||
        existing.parentId === null ||
        existing.parentId === projectId ||
        (sourceProject != null && existing.parentId === sourceProjectId(sourceProject)) ||
        (oldSection !== null && existing.parentId === oldSection);
      if (automatic && (destination === null || catalog.has(destination)))
        catalog.move(id, destination);
    }
  });
}

export async function persistImportedCatalog(
  input: Parameters<typeof applyImportedCatalog>[1] & {
    readonly catalogAccountId?: string | undefined;
  },
  result: Pick<AgentSessionImportResult, "catalogThreads" | "sourceSection">,
  dependencies: {
    readonly accountId: () => string;
    readonly open: (
      accountId: string,
    ) => Promise<{ readonly catalog: MinesCatalog; readonly flush: () => Promise<void> }>;
  },
) {
  const accountId = input.catalogAccountId;
  if (accountId === undefined || accountId !== dependencies.accountId()) return;
  const handle = await dependencies.open(accountId);
  if (accountId !== dependencies.accountId()) return;
  applyImportedCatalog(
    handle.catalog,
    { ...input, sourceSection: result.sourceSection ?? input.sourceSection },
    result.catalogThreads,
  );
  await handle.flush();
}
