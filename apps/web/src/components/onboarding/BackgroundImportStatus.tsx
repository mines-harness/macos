import { useEffect, useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { backgroundImports, useBackgroundImports } from "../../state/backgroundImports";
import { importIssueReports, importSourceLabel } from "../../onboarding/importIssues.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SidebarMenuButton } from "../ui/sidebar";

/** Pauses durable metadata on process exit, without tying requests to a view lifetime. */
export function BackgroundImportCoordinator() {
  useEffect(() => {
    const beforeUnload = () => {
      try {
        backgroundImports.pauseAll();
      } catch {
        /* Storage failure remains visible in the next mounted view. */
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  return null;
}

export function BackgroundImportStatus({
  surface = "sidebar",
}: {
  readonly surface?: "sidebar" | "settings";
}) {
  const { jobs, storageError } = useBackgroundImports();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = (action: () => void) => {
    try {
      action();
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update the import queue.");
    }
  };
  if (
    storageError === null &&
    (jobs.length === 0 || (surface === "sidebar" && jobs.every((job) => job.status === "complete")))
  )
    return null;
  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "running" || job.status === "pausing",
  ).length;
  const pending = jobs.filter((job) => job.status === "paused" || job.status === "failed").length;
  return (
    <>
      {surface === "settings" ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <DownloadIcon /> Import history
        </Button>
      ) : (
        <SidebarMenuButton onClick={() => setOpen(true)} aria-label="View background imports">
          <DownloadIcon />
          <span className="flex-1">Imports</span>
          <span className="text-xs text-muted-foreground">
            {active > 0 ? `${active} active` : pending > 0 ? `${pending} paused` : "Complete"}
          </span>
        </SidebarMenuButton>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Conversation imports</DialogTitle>
            <DialogDescription>
              Imports continue while you use mines. Pause finishes the current batch. After
              quitting, resume from the saved batch; source histories are never changed.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {storageError || actionError ? (
              <p role="alert" className="text-sm text-destructive">
                {storageError ?? actionError}
              </p>
            ) : null}
            {storageError !== null && jobs.length === 0 ? (
              <Button
                variant="outline"
                onClick={() => act(() => backgroundImports.clearUnreadableQueue())}
              >
                Clear unreadable queue
              </Button>
            ) : null}
            {active > 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => act(() => backgroundImports.pauseAll())}
              >
                Pause all imports
              </Button>
            ) : null}
            {jobs.some((job) => job.status === "complete") ? (
              <Button
                size="sm"
                variant="outline"
                disabled={active > 0}
                onClick={() => act(() => backgroundImports.refreshCompleted())}
              >
                <RefreshCwIcon className="size-3.5" />
                Refresh imported history
              </Button>
            ) : null}
            {jobs.map((job) => {
              const issues = importIssueReports(job.sourceReports);
              return (
                <article key={job.id} className="space-y-2 rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">{job.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {job.environmentLabel} ·{" "}
                        {job.status === "pausing" ? "Pausing after this batch" : job.status}
                      </p>
                    </div>
                    {job.status === "running" || job.status === "queued" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => act(() => backgroundImports.pause(job.id))}
                      >
                        Pause
                      </Button>
                    ) : job.status === "paused" || job.status === "failed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act(() => backgroundImports.resume(job.id))}
                      >
                        Resume
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground" role="status">
                    {job.totals.imported} imported · {job.totals.existing} already present ·{" "}
                    {job.totals.native} native · {job.totals.transcripts} transcripts ·{" "}
                    {job.totals.partial} partial
                  </p>
                  {job.totals.failed + job.totals.unavailable + job.totals.skipped > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {job.totals.failed} failed · {job.totals.unavailable} unavailable ·{" "}
                      {job.totals.skipped} skipped.
                    </p>
                  ) : null}
                  {job.error !== null ? (
                    <p role="alert" className="text-xs text-destructive">
                      {job.error}
                    </p>
                  ) : null}
                  {issues.length > 0 ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Import issues ({issues.length})</summary>
                      <ul className="mt-2 space-y-1">
                        {issues.map((report) => (
                          <li key={`${report.source}:${report.message.trim()}`}>
                            {importSourceLabel(report.source)}: {report.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {job.status === "paused" ||
                  job.status === "failed" ||
                  job.status === "complete" ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => act(() => backgroundImports.remove(job.id))}
                    >
                      {job.status === "complete" ? "Dismiss report" : "Remove from queue"}
                    </Button>
                  ) : null}
                </article>
              );
            })}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
