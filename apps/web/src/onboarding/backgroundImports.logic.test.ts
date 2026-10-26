import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  BackgroundImportQueue,
  backgroundImportCompletionNotice,
  type BackgroundImportJob,
  type ImportQueueDependencies,
  type NewBackgroundImportJob,
} from "./backgroundImports.logic";

const job: NewBackgroundImportJob = {
  id: "first",
  environmentId: EnvironmentId.make("computer"),
  environmentLabel: "My computer",
  projectId: ProjectId.make("project"),
  commandId: CommandId.make("mines:import:project:project"),
  title: "Work",
  workspaceRoot: "/work",
  createWorkspaceRootIfMissing: false,
  projectReady: false,
  options: {
    sources: ["codex", "claudeAgent"],
    exportPaths: ["/archive.json"],
    sourceWorkspaceRoot: "/original",
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<ImportQueueDependencies> = {}) {
  let saved: string | null = null;
  const dependencies: ImportQueueDependencies = {
    load: () => saved,
    save: (value) => {
      saved = value;
    },
    checkAccess: () => null,
    createProject: vi.fn(async () => {}),
    importPage: vi.fn(async () => ({ importedCount: 1, skippedCount: 0 })),
    ...overrides,
  };
  return { dependencies, queue: new BackgroundImportQueue(dependencies), saved: () => saved };
}

describe("resumable background imports", () => {
  it("reports queued work as progress and completed history as success", async () => {
    const batch = deferred<AgentSessionImportResult>();
    const { queue } = setup({ importPage: () => batch.promise });
    queue.enqueue([job]);
    expect(backgroundImportCompletionNotice(queue.getSnapshot())).toMatchObject({
      type: "info",
      title: "Importing your history",
    });
    batch.resolve({ importedCount: 1, skippedCount: 0 });
    await queue.whenIdle();
    expect(backgroundImportCompletionNotice(queue.getSnapshot())).toMatchObject({
      type: "success",
      title: "History imported",
    });
  });

  it("reserves failure feedback for an actual failed import", async () => {
    const { queue } = setup({
      importPage: async () => {
        throw new Error("Source became unreadable");
      },
    });
    queue.enqueue([job]);
    await queue.whenIdle();
    expect(backgroundImportCompletionNotice(queue.getSnapshot())).toMatchObject({
      type: "warning",
      title: "Some imports need attention",
    });
  });
  it("commits an in-flight batch before pausing, then resumes its saved cursor", async () => {
    const batch = deferred<AgentSessionImportResult>();
    const started = deferred<void>();
    const importPage = vi
      .fn<ImportQueueDependencies["importPage"]>()
      .mockImplementationOnce(async () => {
        started.resolve();
        return batch.promise;
      })
      .mockResolvedValueOnce({ importedCount: 2, skippedCount: 0, nativeContinuationCount: 2 });
    const { queue, saved } = setup({ importPage });
    queue.enqueue([job]);
    await started.promise;
    queue.pause(job.id);
    expect(queue.getSnapshot().jobs[0]?.status).toBe("pausing");
    batch.resolve({
      importedCount: 3,
      skippedCount: 0,
      hasMore: true,
      nextCursor: 32,
      partialCount: 1,
    });
    await queue.whenIdle();
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "paused",
      cursor: 32,
      totals: { imported: 3, partial: 1 },
    });
    expect(JSON.parse(saved()!).jobs[0].cursor).toBe(32);
    expect(importPage).toHaveBeenCalledOnce();
    queue.resume(job.id);
    await queue.whenIdle();
    expect(importPage.mock.calls[1]?.[0]).toMatchObject({ cursor: 32, options: job.options });
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "complete",
      totals: { imported: 5, native: 2, partial: 1 },
    });
  });

  it("rechecks access after project creation and reuses the committed project on resume", async () => {
    let allowed = true;
    const createProject = vi.fn(async () => {
      allowed = false;
    });
    const { queue, dependencies } = setup({
      createProject,
      checkAccess: () => (allowed ? null : "Permission revoked"),
    });
    queue.enqueue([job]);
    await queue.whenIdle();
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "paused",
      projectReady: true,
      error: "Permission revoked",
    });
    expect(dependencies.importPage).not.toHaveBeenCalled();
    allowed = true;
    queue.resume(job.id);
    await queue.whenIdle();
    expect(createProject).toHaveBeenCalledOnce();
    expect(dependencies.importPage).toHaveBeenCalledOnce();
  });

  it("restores interrupted work as paused and retries with the same project command", async () => {
    const creation = deferred<void>();
    const { queue, saved } = setup({ createProject: () => creation.promise });
    queue.enqueue([job]);
    const createProject = vi.fn<ImportQueueDependencies["createProject"]>(async () => {});
    const restored = setup({ load: saved, createProject });
    expect(restored.queue.getSnapshot().jobs[0]?.status).toBe("paused");
    expect(createProject).not.toHaveBeenCalled();
    restored.queue.resume(job.id);
    await restored.queue.whenIdle();
    expect(createProject.mock.calls[0]?.[0]).toMatchObject({
      projectId: job.projectId,
      commandId: job.commandId,
    });
    queue.pause(job.id);
    creation.resolve();
    await queue.whenIdle();
  });

  it.each([
    { status: "paused", error: null },
    { status: "paused", error: "Permission revoked" },
    { status: "failed", error: "Saved import source is unavailable" },
    { status: "complete", error: null },
  ] as const)(
    "preserves a restored $status job and its saved error ($error)",
    ({ status, error }) => {
      const savedJob = {
        ...job,
        status,
        error,
        cursor: 32,
        totals: {
          imported: 3,
          existing: 2,
          skipped: 1,
          native: 3,
          transcripts: 0,
          partial: 0,
          failed: 0,
          unavailable: 1,
        },
        sourceReports: [
          { source: "opencode", status: "unavailable", message: "Saved source is unavailable" },
        ],
      } satisfies BackgroundImportJob;
      const { queue, dependencies } = setup({
        load: () => JSON.stringify({ version: 1, jobs: [savedJob] }),
      });
      expect(queue.getSnapshot().jobs).toEqual([savedJob]);
      expect(dependencies.createProject).not.toHaveBeenCalled();
      expect(dependencies.importPage).not.toHaveBeenCalled();
    },
  );

  it("does not loop on malformed pagination and retries the unacknowledged batch", async () => {
    const importPage = vi
      .fn<ImportQueueDependencies["importPage"]>()
      .mockResolvedValueOnce({ importedCount: 1, skippedCount: 0, hasMore: true, nextCursor: 4 })
      .mockResolvedValueOnce({ importedCount: 1, skippedCount: 0, hasMore: true, nextCursor: 4 })
      .mockResolvedValueOnce({ importedCount: 0, skippedCount: 0, alreadyImportedCount: 1 });
    const { queue } = setup({ importPage });
    queue.enqueue([job]);
    await queue.whenIdle();
    expect(queue.getSnapshot().jobs[0]).toMatchObject({ status: "failed", cursor: 4 });
    expect(importPage).toHaveBeenCalledTimes(2);
    queue.resume(job.id);
    await queue.whenIdle();
    expect(importPage.mock.calls[2]?.[0].cursor).toBe(4);
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "complete",
      totals: { existing: 1 },
    });
  });

  it("refreshes completed sources from the beginning without recreating projects or resuming stopped jobs", async () => {
    const completed = {
      ...job,
      projectReady: true,
      catalogAccountId: "catalog-account",
      sourceSection: { id: "opencode", title: "OpenCode", order: 2 },
      options: { ...job.options, cursor: 64 },
      cursor: 96,
      status: "complete",
      error: null,
      totals: {
        imported: 3,
        existing: 2,
        skipped: 1,
        native: 3,
        transcripts: 0,
        partial: 0,
        failed: 0,
        unavailable: 1,
      },
      sourceReports: [
        { source: "opencode", status: "unavailable", message: "Previous source report" },
      ],
    } satisfies BackgroundImportJob;
    const paused = { ...completed, id: "paused", status: "paused", error: "Permission revoked" };
    const failed = { ...completed, id: "failed", status: "failed", error: "Source unavailable" };
    const batch = deferred<AgentSessionImportResult>();
    const started = deferred<void>();
    const { queue, dependencies } = setup({
      load: () => JSON.stringify({ version: 1, jobs: [completed, paused, failed] }),
      importPage: vi.fn(async () => {
        started.resolve();
        return batch.promise;
      }),
    });
    queue.refreshCompleted();
    await started.promise;
    const refreshed = queue.getSnapshot().jobs;
    expect(refreshed).toHaveLength(3);
    expect(refreshed[0]).toEqual({
      ...completed,
      cursor: 0,
      status: "running",
      totals: {
        imported: 0,
        existing: 0,
        skipped: 0,
        native: 0,
        transcripts: 0,
        partial: 0,
        failed: 0,
        unavailable: 0,
      },
      sourceReports: [],
    });
    expect(refreshed.slice(1)).toEqual([paused, failed]);
    expect(dependencies.createProject).not.toHaveBeenCalled();
    expect(dependencies.importPage).toHaveBeenCalledWith(refreshed[0]);
    queue.refreshCompleted();
    expect(dependencies.importPage).toHaveBeenCalledOnce();
    batch.resolve({ importedCount: 1, skippedCount: 0, alreadyImportedCount: 3 });
    await queue.whenIdle();
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "complete",
      totals: { imported: 1, existing: 3, unavailable: 0 },
    });
  });

  it("never starts work if its resumable state cannot be saved", () => {
    const { queue, dependencies } = setup({
      save: () => {
        throw new Error("Full disk");
      },
    });
    expect(() => queue.enqueue([job])).toThrow("could not be saved");
    expect(dependencies.createProject).not.toHaveBeenCalled();
    expect(dependencies.importPage).not.toHaveBeenCalled();
    expect(queue.getSnapshot().jobs[0]?.status).toBe("paused");
  });

  it("deduplicates queued sources and retains truthful coverage after a completed batch", async () => {
    const pending = deferred<AgentSessionImportResult>();
    const { queue } = setup({ importPage: () => pending.promise });
    queue.enqueue([{ ...job, projectReady: true }]);
    queue.enqueue([{ ...job, id: "same-source" }]);
    expect(queue.getSnapshot().jobs).toHaveLength(1);
    pending.resolve({
      importedCount: 1,
      skippedCount: 2,
      partialCount: 1,
      unavailableCount: 1,
      sourceReports: [
        { source: "antigravity", status: "unsupported", message: "Native store is not supported" },
      ],
    });
    await queue.whenIdle();
    expect(queue.getSnapshot().jobs[0]).toMatchObject({
      status: "complete",
      totals: { imported: 1, skipped: 2, unavailable: 1, partial: 1 },
      sourceReports: [{ status: "unsupported" }],
    });
  });
});
