import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type {
  AgentSessionProjectCandidate,
  AgentSessionSourceSection,
  AgentSessionThreadCandidate,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SELECTION_MIN_THREADS = 3;

/** Treat candidates missing git as repositories for servers predating git scans. */
export function partitionOnboardingProjects<T extends AgentSessionProjectCandidate>(
  candidates: ReadonlyArray<T>,
  now = Date.now(),
) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available: candidates,
    recent: candidates.filter((candidate) => {
      if (candidate.git === null) return false;
      if (candidate.threadCount < DEFAULT_SELECTION_MIN_THREADS) return false;
      if (candidate.lastActiveAt === null) return false;
      const lastActiveAt = Date.parse(candidate.lastActiveAt);
      return lastActiveAt >= cutoff && lastActiveAt <= now;
    }),
  };
}

/** Use the server's project match before the client snapshot, which can lag behind the scan. */
export function resolveOnboardingProjectId(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
  environmentId: EnvironmentId,
  candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
): ProjectId | null {
  if (candidate.projectId !== undefined) return candidate.projectId;
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const currentRootMatch = findProjectByPath(environmentProjects, candidate.path);
  if (currentRootMatch !== undefined) return currentRootMatch.id;
  return null;
}

export function resolveOnboardingLandingProject<T>(
  selection: ReadonlyArray<string>,
  projectsWithImportedHistory: ReadonlyMap<string, T>,
  completedProjects: ReadonlyMap<string, T>,
): T | undefined {
  for (const path of selection) {
    const project = projectsWithImportedHistory.get(path);
    if (project !== undefined) return project;
  }
  for (const path of selection) {
    const project = completedProjects.get(path);
    if (project !== undefined) return project;
  }
  return undefined;
}

export function onboardingProjectKey(environmentId: EnvironmentId, path: string): string {
  return JSON.stringify([environmentId, path]);
}

export type ImportSelection = {
  readonly projects: ReadonlySet<string>;
  readonly threads: ReadonlyMap<string, ReadonlySet<string>>;
};

export type ImportSelectionChange = {
  readonly projectKey: string;
  readonly threadKeys?: readonly string[] | undefined;
  readonly checked: boolean;
};

export function importSelectionCounts(
  candidates: readonly (AgentSessionProjectCandidate & { readonly key: string })[],
  selection: ImportSelection,
) {
  let conversations = 0;
  let subagents = 0;
  for (const candidate of candidates) {
    if (!selection.projects.has(candidate.key)) continue;
    if (!candidate.threads) {
      conversations += candidate.threadCount;
      continue;
    }
    for (const thread of candidate.threads) {
      if (selection.threads.get(candidate.key)?.has(thread.key) === false) continue;
      if (thread.kind === "subagent") subagents++;
      else conversations++;
    }
  }
  return { conversations, subagents };
}

export type ImportCandidate = AgentSessionProjectCandidate & {
  readonly key: string;
  readonly environmentId?: EnvironmentId;
};

export interface ImportThreadNode<T extends ImportCandidate = ImportCandidate> {
  readonly candidate: T;
  readonly thread: AgentSessionThreadCandidate;
  readonly children: ImportThreadNode<T>[];
}

export function importThreadForest<T extends ImportCandidate>(candidates: readonly T[]) {
  const nodes: ImportThreadNode<T>[] = candidates.flatMap((candidate) =>
    (candidate.threads ?? []).map((thread) => ({ candidate, thread, children: [] })),
  );
  const identity = (node: ImportThreadNode<T>, nativeId: string) =>
    JSON.stringify([node.candidate.environmentId ?? "", node.thread.source, nativeId]);
  const byNativeId = new Map<string, ImportThreadNode<T>[]>();
  for (const node of nodes) {
    if (!node.thread.sourceThreadId) continue;
    const key = identity(node, node.thread.sourceThreadId);
    byNativeId.set(key, [...(byNativeId.get(key) ?? []), node]);
  }
  const parents = new Map<ImportThreadNode<T>, ImportThreadNode<T>>();
  for (const node of nodes) {
    if (node.thread.kind !== "subagent" || !node.thread.sourceParentThreadId) continue;
    const matches = byNativeId.get(identity(node, node.thread.sourceParentThreadId)) ?? [];
    const parent =
      matches.find((item) => item.candidate.key === node.candidate.key) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (parent && parent !== node) parents.set(node, parent);
  }
  const roots: ImportThreadNode<T>[] = [];
  for (const node of nodes) {
    const seen = new Set([node]);
    let ancestor = parents.get(node);
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor)) {
        cycle = true;
        break;
      }
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const parent = cycle ? undefined : parents.get(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function importThreadScope<T extends ImportCandidate>(
  nodes: readonly ImportThreadNode<T>[],
) {
  const scopes = new Map<string, string[]>();
  const visit = (node: ImportThreadNode<T>) => {
    const keys = scopes.get(node.candidate.key) ?? [];
    if (!keys.includes(node.thread.key)) keys.push(node.thread.key);
    scopes.set(node.candidate.key, keys);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return scopes;
}

export function updateImportSelection<
  T extends AgentSessionProjectCandidate & { readonly key: string },
>(
  selection: ImportSelection,
  candidates: readonly T[],
  changes: readonly ImportSelectionChange[],
): ImportSelection {
  const projects = new Set(selection.projects);
  const threads = new Map(selection.threads);
  const roots = importThreadForest(candidates);
  const nodeByKey = new Map<string, ImportThreadNode<T>>();
  const index = (node: ImportThreadNode<T>) => {
    nodeByKey.set(JSON.stringify([node.candidate.key, node.thread.key]), node);
    node.children.forEach(index);
  };
  roots.forEach(index);
  const expanded = changes.flatMap((change) => {
    const candidate = candidates.find((item) => item.key === change.projectKey);
    if (!candidate?.threads?.length) return [change];
    const nodes = (change.threadKeys ?? candidate.threads.map((thread) => thread.key)).flatMap(
      (key) => nodeByKey.get(JSON.stringify([change.projectKey, key])) ?? [],
    );
    return [...importThreadScope(nodes)].map(([projectKey, threadKeys]) => ({
      projectKey,
      threadKeys,
      checked: change.checked,
    }));
  });
  for (const change of expanded) {
    const candidate = candidates.find((item) => item.key === change.projectKey);
    if (!candidate) continue;
    if (change.threadKeys === undefined || candidate.threads === undefined) {
      if (change.checked) projects.add(change.projectKey);
      else projects.delete(change.projectKey);
      threads.delete(change.projectKey);
      continue;
    }
    const all = candidate.threads.map((thread) => thread.key);
    const current = new Set(
      projects.has(change.projectKey) ? (threads.get(change.projectKey) ?? all) : [],
    );
    for (const key of change.threadKeys) {
      if (change.checked && all.includes(key)) current.add(key);
      else current.delete(key);
    }
    if (current.size > 0) projects.add(change.projectKey);
    else projects.delete(change.projectKey);
    if (current.size > 0 && current.size < all.length) threads.set(change.projectKey, current);
    else threads.delete(change.projectKey);
  }
  return { projects, threads };
}

export function groupImportSections<T extends ImportCandidate>(candidates: readonly T[]) {
  type View = {
    candidate: T;
    title: string;
    sourceProjectId: string | undefined;
    threads: readonly AgentSessionThreadCandidate[] | undefined;
    threadKeys: readonly string[] | undefined;
    nodes: ImportThreadNode<T>[] | undefined;
  };
  type Group = {
    key: string;
    title: string;
    sourceSection: AgentSessionSourceSection | undefined;
    projects: View[];
    threads: ImportThreadNode<T>[];
  };
  const groups = new Map<string, Group>();
  const groupFor = (section: AgentSessionSourceSection | undefined) => {
    const key = section?.id ?? "unsectioned";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: section?.title ?? "Other projects",
        sourceSection: section,
        projects: [],
        threads: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const candidate of candidates) {
    if (candidate.threads?.length) continue;
    groupFor(candidate.sourceSection).projects.push({
      candidate,
      title: candidate.sourceProject?.title ?? candidate.title,
      sourceProjectId: candidate.sourceProject?.id,
      threads: candidate.threads,
      threadKeys: candidate.threads?.map((thread) => thread.key),
      nodes: candidate.threads ? [] : undefined,
    });
  }
  for (const node of importThreadForest(candidates)) {
    const candidate = node.candidate;
    const group = groupFor(node.thread.sourceSection ?? candidate.sourceSection);
    const sourceProject =
      node.thread.sourceProject === undefined ? candidate.sourceProject : node.thread.sourceProject;
    if (sourceProject === null) {
      group.threads.push(node);
      continue;
    }
    let view = group.projects.find(
      (item) => item.candidate.key === candidate.key && item.sourceProjectId === sourceProject?.id,
    );
    if (!view) {
      view = {
        candidate,
        title: sourceProject?.title ?? candidate.title,
        sourceProjectId: sourceProject?.id,
        threads: [],
        threadKeys: [],
        nodes: [],
      };
      group.projects.push(view);
    }
    view.nodes!.push(node);
    const keys = importThreadScope(view.nodes!).get(candidate.key) ?? [];
    view.threadKeys = keys;
    view.threads = candidate.threads?.filter((thread) => keys.includes(thread.key));
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.sourceSection) return b.sourceSection ? 1 : 0;
    if (!b.sourceSection) return -1;
    return (
      (a.sourceSection.order ?? Number.MAX_SAFE_INTEGER) -
      (b.sourceSection.order ?? Number.MAX_SAFE_INTEGER)
    );
  });
}
