import {
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionSourceSection,
  AgentSessionSourceProject,
  CommandId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ImportTotals = Schema.Struct({
  imported: Schema.Number,
  existing: Schema.Number,
  skipped: Schema.Number,
  native: Schema.Number,
  transcripts: Schema.Number,
  partial: Schema.Number,
  failed: Schema.Number,
  unavailable: Schema.Number,
});
export const BackgroundImportJob = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  projectId: ProjectId,
  commandId: CommandId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  createWorkspaceRootIfMissing: Schema.Boolean,
  projectReady: Schema.Boolean,
  options: AgentSessionScanInput,
  catalogAccountId: Schema.optional(Schema.String),
  sourceSection: Schema.optional(AgentSessionSourceSection),
  sourceProject: Schema.optional(Schema.NullOr(AgentSessionSourceProject)),
  cursor: Schema.optional(Schema.Number),
  status: Schema.Literals(["queued", "running", "pausing", "paused", "failed", "complete"]),
  error: Schema.NullOr(Schema.String),
  totals: ImportTotals,
  sourceReports: Schema.Array(
    Schema.Struct({ source: Schema.String, status: Schema.String, message: Schema.String }),
  ),
});
export type BackgroundImportJob = typeof BackgroundImportJob.Type;
export type NewBackgroundImportJob = Omit<
  BackgroundImportJob,
  "status" | "error" | "totals" | "sourceReports"
>;
const SavedQueue = Schema.Struct({
  version: Schema.Literal(1),
  jobs: Schema.Array(BackgroundImportJob),
});
const decodeSavedQueue = Schema.decodeSync(Schema.fromJsonString(SavedQueue));
const ZERO_TOTALS: typeof ImportTotals.Type = {
  imported: 0,
  existing: 0,
  skipped: 0,
  native: 0,
  transcripts: 0,
  partial: 0,
  failed: 0,
  unavailable: 0,
};
export interface ImportQueueSnapshot {
  readonly jobs: readonly BackgroundImportJob[];
  readonly storageError: string | null;
}

export function backgroundImportCompletionNotice({ jobs, storageError }: ImportQueueSnapshot) {
  if (
    storageError ||
    jobs.some(
      (job) => job.status === "failed" || job.totals.failed > 0 || job.totals.unavailable > 0,
    )
  )
    return {
      type: "warning",
      title: "Some imports need attention",
      description: "Review the import issues in Settings → Projects → Import history.",
    } as const;
  if (
    jobs.some(
      (job) => job.status === "queued" || job.status === "running" || job.status === "pausing",
    )
  )
    return {
      type: "info",
      title: "Importing your history",
      description: "Imports continue in the background while you use mines.",
    } as const;
  if (jobs.some((job) => job.status === "paused"))
    return {
      type: "info",
      title: "Imports paused",
      description: "Resume your imports from the sidebar.",
    } as const;
  if (jobs.some((job) => job.totals.partial > 0))
    return {
      type: "warning",
      title: "Some imported history is incomplete",
      description: "Review the import issues in Settings → Projects → Import history.",
    } as const;
  return jobs.length > 0 ? ({ type: "success", title: "History imported" } as const) : null;
}
export interface ImportQueueDependencies {
  readonly load: () => string | null;
  readonly save: (value: string) => void;
  readonly checkAccess: (job: BackgroundImportJob) => string | null;
  readonly createProject: (job: BackgroundImportJob) => Promise<void>;
  readonly importPage: (job: BackgroundImportJob) => Promise<AgentSessionImportResult>;
  readonly currentCatalogAccountId?: () => string;
}

/** Owns requests independently of React lifecycles. Only job metadata is persisted. */
export class BackgroundImportQueue {
  private snapshot: ImportQueueSnapshot = { jobs: [], storageError: null };
  private readonly listeners = new Set<() => void>();
  private active: Promise<void> | null = null;

  constructor(private readonly dependencies: ImportQueueDependencies) {
    try {
      const saved = dependencies.load();
      if (saved !== null) {
        const decoded = decodeSavedQueue(saved);
        this.snapshot = {
          jobs: decoded.jobs.map((job) =>
            job.status === "queued" || job.status === "running" || job.status === "pausing"
              ? {
                  ...job,
                  status: "paused",
                  error: "Import paused when mines closed. Resume when this computer is available.",
                }
              : job,
          ),
          storageError: null,
        };
      }
    } catch {
      this.snapshot = {
        jobs: [],
        storageError:
          "Saved imports could not be read. Clear the saved queue before starting another import.",
      };
    }
  }

  getSnapshot = (): ImportQueueSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish() {
    for (const listener of this.listeners) listener();
  }
  private commit(jobs: readonly BackgroundImportJob[]) {
    this.snapshot = { jobs, storageError: null };
    try {
      this.dependencies.save(JSON.stringify({ version: 1, jobs }));
    } catch {
      this.snapshot = {
        jobs: jobs.map((job) =>
          job.status === "queued" || job.status === "running" || job.status === "pausing"
            ? { ...job, status: "paused" }
            : job,
        ),
        storageError:
          "Import progress could not be saved. Free some storage and resume; committed conversations are safe to retry.",
      };
      this.publish();
      throw new Error(this.snapshot.storageError!);
    }
    this.publish();
  }
  private update(id: string, change: Partial<BackgroundImportJob>) {
    this.commit(this.snapshot.jobs.map((job) => (job.id === id ? { ...job, ...change } : job)));
  }
  enqueue(jobs: readonly NewBackgroundImportJob[]) {
    if (this.snapshot.storageError !== null) throw new Error(this.snapshot.storageError);
    const signature = (job: NewBackgroundImportJob) =>
      JSON.stringify([
        job.environmentId,
        job.workspaceRoot,
        job.options,
        job.catalogAccountId,
        job.sourceSection,
      ]);
    const pending = new Set(
      this.snapshot.jobs.filter((job) => job.status !== "complete").map(signature),
    );
    this.commit([
      ...this.snapshot.jobs,
      ...jobs
        .filter((job) => !pending.has(signature(job)))
        .map((job) => ({
          ...job,
          status: "queued" as const,
          error: null,
          totals: ZERO_TOTALS,
          sourceReports: [],
        })),
    ]);
    void this.run();
  }
  pause(id: string) {
    const job = this.snapshot.jobs.find((item) => item.id === id);
    if (job?.status !== "running" && job?.status !== "queued") return;
    this.update(id, { status: job.status === "running" ? "pausing" : "paused", error: null });
  }
  pauseAll() {
    if (!this.snapshot.jobs.some((job) => job.status === "running" || job.status === "queued"))
      return;
    this.commit(
      this.snapshot.jobs.map((job) =>
        job.status === "running"
          ? { ...job, status: "pausing" }
          : job.status === "queued"
            ? { ...job, status: "paused" }
            : job,
      ),
    );
  }
  resume(id: string) {
    const job = this.snapshot.jobs.find((item) => item.id === id);
    if (job?.status !== "paused" && job?.status !== "failed") return;
    this.update(id, { status: "queued", error: null });
    void this.run();
  }
  refreshCompleted() {
    if (this.snapshot.storageError !== null) throw new Error(this.snapshot.storageError);
    if (!this.snapshot.jobs.some((job) => job.status === "complete")) return;
    const catalogAccountId = this.dependencies.currentCatalogAccountId?.();
    this.commit(
      this.snapshot.jobs.map((job) =>
        job.status === "complete"
          ? {
              ...job,
              ...(job.catalogAccountId === undefined && catalogAccountId !== undefined
                ? { catalogAccountId }
                : {}),
              status: "queued",
              cursor: 0,
              error: null,
              totals: ZERO_TOTALS,
              sourceReports: [],
            }
          : job,
      ),
    );
    void this.run();
  }
  remove(id: string) {
    if (
      this.snapshot.jobs.some(
        (job) => job.id === id && (job.status === "running" || job.status === "pausing"),
      )
    )
      return;
    this.commit(this.snapshot.jobs.filter((job) => job.id !== id));
  }
  clearUnreadableQueue() {
    if (this.snapshot.jobs.length === 0) this.commit([]);
  }
  /** Tests and shutdown observers can await the actual worker, never a polling timer. */
  whenIdle(): Promise<void> {
    return this.active ?? Promise.resolve();
  }
  private run(): Promise<void> {
    if (this.active !== null) return this.active;
    this.active = this.drain().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async drain() {
    while (this.snapshot.storageError === null) {
      let job = this.snapshot.jobs.find((item) => item.status === "queued");
      if (!job) return;
      const id = job.id;
      try {
        this.update(id, { status: "running", error: null });
        while (true) {
          job = this.snapshot.jobs.find((item) => item.id === id)!;
          if (job.status === "pausing") {
            this.update(id, { status: "paused" });
            break;
          }
          if (job.status !== "running") break;
          const denied = this.dependencies.checkAccess(job);
          if (denied !== null) {
            this.update(id, { status: "paused", error: denied });
            break;
          }
          if (!job.projectReady) {
            await this.dependencies.createProject(job);
            // The stable command ID survives an interrupted create acknowledgement.
            this.update(id, { projectReady: true });
            continue;
          }
          const result = await this.dependencies.importPage(job);
          const current = this.snapshot.jobs.find((item) => item.id === id)!;
          const hasMore = result.hasMore === true;
          if (
            hasMore &&
            (result.nextCursor === undefined || result.nextCursor <= (job.cursor ?? -1))
          ) {
            throw new Error(
              "The importer returned a non-advancing cursor. Retry after updating this computer.",
            );
          }
          const reports = [...current.sourceReports, ...(result.sourceReports ?? [])];
          const uniqueReports = [
            ...new Map(
              reports.map((report) => [
                `${report.source}:${report.status}:${report.message}`,
                report,
              ]),
            ).values(),
          ];
          this.update(id, {
            ...(hasMore ? { cursor: result.nextCursor } : {}),
            totals: {
              imported: current.totals.imported + result.importedCount,
              existing: current.totals.existing + (result.alreadyImportedCount ?? 0),
              skipped: current.totals.skipped + result.skippedCount,
              native: current.totals.native + (result.nativeContinuationCount ?? 0),
              transcripts: current.totals.transcripts + (result.transcriptOnlyCount ?? 0),
              partial: current.totals.partial + (result.partialCount ?? 0),
              failed: current.totals.failed + (result.failedCount ?? 0),
              unavailable: current.totals.unavailable + (result.unavailableCount ?? 0),
            },
            sourceReports: uniqueReports,
            status: !hasMore ? "complete" : current.status === "pausing" ? "paused" : "running",
          });
        }
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause.message
            : "Import failed. Resume to retry the saved batch.";
        try {
          this.update(id, { status: "failed", error });
        } catch {
          return;
        }
      }
    }
  }
}
