import type { AgentSessionScanResult } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { BackgroundImportJob } from "./backgroundImports.logic";

export async function createProjectForRetainedHistory(
  job: BackgroundImportJob,
  scan: () => Promise<AgentSessionScanResult>,
  createProject: () => Promise<void>,
) {
  const history = await scan();
  const workspace = normalizeProjectPathForComparison(
    job.options.sourceWorkspaceRoot ?? job.workspaceRoot,
  );
  const keys = job.options.threadKeys === undefined ? null : new Set(job.options.threadKeys);
  const available = history.candidates.some(
    (candidate) =>
      normalizeProjectPathForComparison(candidate.sourceWorkspaceRoot ?? candidate.path) ===
        workspace &&
      candidate.threadCount > 0 &&
      (job.options.sources === undefined ||
        candidate.sources.some((source) => job.options.sources?.includes(source))) &&
      (keys === null || candidate.threads?.some((thread) => keys.has(thread.key))),
  );
  if (!available)
    throw new Error(
      "Selected history is no longer available on this computer. Choose retained history before creating its workspace.",
    );
  await createProject();
}
