import { EnvironmentId, ProjectId, type AgentSessionProjectCandidate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  groupImportSections,
  updateImportSelection,
  importSelectionCounts,
} from "./projectImport.logic";

const now = Date.parse("2026-08-22T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 3,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    git: { remoteKey: null, repository: null },
    ...overrides,
  };
}

it("previews actual project and direct-mine sections without inventing repository sections", () => {
  const project = {
    ...candidate("/code/app"),
    key: "app",
    sourceSection: { id: "work", title: "Work", order: 1 },
    threads: [
      { key: "one", title: "First", source: "codex" as const, lastActiveAt: null },
      {
        key: "two",
        title: "Second",
        source: "codex" as const,
        lastActiveAt: null,
        sourceSection: { id: "studio", title: "Studio", order: 0 },
      },
    ],
  };
  const legacy = { ...candidate("/code/legacy"), key: "legacy" };
  const groups = groupImportSections([project, legacy]);
  expect(
    groups.map((group) => [
      group.title,
      group.projects.map((view) => [view.candidate.key, view.threadKeys]),
    ]),
  ).toEqual([
    ["Studio", [["app", ["two"]]]],
    ["Work", [["app", ["one"]]]],
    ["Other projects", [["legacy", undefined]]],
  ]);
});

it("keeps mine selection stable across section aliases and reselecting a whole project", () => {
  const project = {
    ...candidate("/code/app"),
    key: "app",
    threads: [
      { key: "one", title: "First", source: "codex" as const, lastActiveAt: null },
      { key: "two", title: "Second", source: "codex" as const, lastActiveAt: null },
    ],
  };
  const initial = { projects: new Set(["app"]), threads: new Map<string, ReadonlySet<string>>() };
  const partial = updateImportSelection(
    initial,
    [project],
    [{ projectKey: "app", threadKeys: ["one"], checked: false }],
  );
  expect([...partial.projects]).toEqual(["app"]);
  expect([...partial.threads.get("app")!]).toEqual(["two"]);
  const none = updateImportSelection(
    partial,
    [project],
    [{ projectKey: "app", threadKeys: ["two"], checked: false }],
  );
  expect(none.projects.size).toBe(0);
  const all = updateImportSelection(none, [project], [{ projectKey: "app", checked: true }]);
  expect([...all.projects]).toEqual(["app"]);
  expect(all.threads.size).toBe(0);
});

it("shows projectless source roots directly and nests their subagents across execution workspaces", () => {
  const root = {
    ...candidate("/cwd/root"),
    key: "root-cwd",
    sourceProject: null,
    threads: [
      {
        key: "root",
        sourceThreadId: "native-root",
        kind: "thread" as const,
        sourceProject: null,
        title: "Real conversation",
        source: "codex" as const,
        lastActiveAt: null,
      },
      {
        key: "child",
        sourceThreadId: "native-child",
        sourceParentThreadId: "native-root",
        kind: "subagent" as const,
        sourceProject: null,
        agentName: "Ada",
        title: "UUID",
        source: "codex" as const,
        lastActiveAt: null,
      },
    ],
  };
  const other = {
    ...candidate("/cwd/worker"),
    key: "worker-cwd",
    sourceProject: null,
    threads: [
      {
        key: "grandchild",
        sourceThreadId: "native-grandchild",
        sourceParentThreadId: "native-child",
        kind: "subagent" as const,
        sourceProject: null,
        title: "UUID2",
        source: "codex" as const,
        lastActiveAt: null,
      },
    ],
  };
  const groups = groupImportSections([root, other]);
  expect(groups.flatMap((group) => group.projects)).toEqual([]);
  const nodes = groups.flatMap((group) => group.threads);
  expect(nodes.map((node) => node.thread.key)).toEqual(["root"]);
  expect(nodes[0]?.children[0]?.children[0]?.thread.key).toBe("grandchild");
  const selected = updateImportSelection(
    { projects: new Set<string>(), threads: new Map() },
    [root, other],
    [{ projectKey: root.key, threadKeys: ["root"], checked: true }],
  );
  expect([...selected.projects]).toEqual(["root-cwd", "worker-cwd"]);
  expect(selected.threads.size).toBe(0);
  expect(importSelectionCounts([root, other], selected)).toEqual({
    conversations: 1,
    subagents: 2,
  });
});

describe("partitionOnboardingProjects", () => {
  it("keeps existing projects available for thread history import", () => {
    const imported = candidate("/projects/current", { alreadyImported: true });
    const available = candidate("/projects/other");

    expect(partitionOnboardingProjects([imported, available], now)).toEqual({
      available: [imported, available],
      recent: [imported, available],
    });
  });

  it("keeps projects older than 30 days out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const older = candidate("/projects/older", {
      lastActiveAt: "2026-07-01T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, older], now)).toEqual({
      available: [recent, older],
      recent: [recent],
    });
  });

  it("keeps non-git folders and thin histories out of the default selection", () => {
    const repo = candidate("/projects/repo");
    const folder = candidate("/projects/folder", { git: null });
    const thin = candidate("/projects/thin", { threadCount: 2 });

    expect(partitionOnboardingProjects([repo, folder, thin], now).recent).toEqual([repo]);
  });

  it("selects candidates from servers that do not report git identity", () => {
    const { git: _git, ...legacy } = candidate("/projects/legacy");

    expect(partitionOnboardingProjects([legacy], now).recent).toEqual([legacy]);
  });
});

describe("resolveOnboardingProjectId", () => {
  const localEnvironmentId = EnvironmentId.make("local");
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const localProjectId = ProjectId.make("local-project");

  it("uses the scanned project ID when the client still has an older project at that root", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("stale-project"),
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo", { projectId: localProjectId }),
      ),
    ).toBe(localProjectId);
  });

  it("finds an existing project by normalized root in the target environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo",
          },
          {
            id: localProjectId,
            environmentId: localEnvironmentId,
            workspaceRoot: "C:\\Work\\Repo\\",
          },
        ],
        localEnvironmentId,
        candidate("c:/work/repo"),
      ),
    ).toBe(localProjectId);
  });

  it("does not reuse a project from another environment", () => {
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("remote-project"),
            environmentId: remoteEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        candidate("/projects/repo"),
      ),
    ).toBeNull();
  });
});

describe("resolveOnboardingLandingProject", () => {
  it("prefers a partial first import that added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/partial", "/projects/complete"],
        new Map([["/projects/partial", "partial"]]),
        new Map([["/projects/complete", "complete"]]),
      ),
    ).toBe("partial");
  });

  it("uses a completed zero-history project when no import added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/empty", "/projects/failed"],
        new Map(),
        new Map([["/projects/empty", "empty"]]),
      ),
    ).toBe("empty");
  });

  it("ignores cached successes outside the current retry selection", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/current"],
        new Map([["/projects/previous", "previous"]]),
        new Map([
          ["/projects/previous", "previous"],
          ["/projects/current", "current"],
        ]),
      ),
    ).toBe("current");
  });
});

describe("projects on multiple computers", () => {
  it("keeps identical paths independent when selecting a landing project after partial imports", () => {
    const first = onboardingProjectKey(EnvironmentId.make("first"), "/code/app");
    const second = onboardingProjectKey(EnvironmentId.make("second"), "/code/app");
    const completed = new Map([[first, "first-project"]]);
    expect(completed.has(second)).toBe(false);
    expect(resolveOnboardingLandingProject([second], completed, completed)).toBeUndefined();
    completed.set(second, "second-project");
    expect(resolveOnboardingLandingProject([second, first], completed, completed)).toBe(
      "second-project",
    );
  });

  // regression: #10465 multi-computer onboarding mixed up which computer a project came from
  it("preserves computer identity when choosing recent projects", () => {
    const first = { ...candidate("/code/app"), environmentId: "first" };
    const second = { ...candidate("/code/app"), environmentId: "second" };
    expect(partitionOnboardingProjects([first, second], now).recent).toEqual([first, second]);
  });
});
