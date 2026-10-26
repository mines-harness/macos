import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useSyncExternalStore } from "react";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { BackgroundImportQueue } from "../onboarding/backgroundImports.logic";
import { createProjectForRetainedHistory } from "../onboarding/backgroundImportPreflight";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { agentSessionImport, agentSessionScan } from "./agentSessions";
import { projectEnvironment } from "./projects";
import { readEnvironmentScope } from "./session";
import { environmentPresentations } from "./presentation";
import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import { openBrowserCatalog } from "../catalog/useMinesCatalog";
import { persistImportedCatalog } from "../onboarding/importCatalog.logic";

const STORAGE_KEY = "mines:background-imports:v1";
const catalogPersistence = {
  accountId: () => appAtomRegistry.get(minesAccountIdAtom) ?? "local-device",
  open: openBrowserCatalog,
};
export const backgroundImports = new BackgroundImportQueue({
  load: () => globalThis.localStorage?.getItem(STORAGE_KEY) ?? null,
  save: (value) => globalThis.localStorage.setItem(STORAGE_KEY, value),
  currentCatalogAccountId: catalogPersistence.accountId,
  checkAccess: (job) => {
    if (
      job.catalogAccountId !== undefined &&
      job.catalogAccountId !== (appAtomRegistry.get(minesAccountIdAtom) ?? "local-device")
    )
      return "Your account changed. Sign in to the original account to resume this import.";
    const presentation = appAtomRegistry.get(
      environmentPresentations.presentationAtom(job.environmentId),
    );
    if (presentation?.connection.phase !== "connected")
      return "Computer unavailable. Reconnect, then resume this import.";
    return readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)
      ? null
      : "This connection no longer permits imports. Restore its access, then resume.";
  },
  createProject: async (job) => {
    const scan = agentSessionScan({ environmentId: job.environmentId, input: job.options });
    await createProjectForRetainedHistory(
      job,
      async () => {
        appAtomRegistry.refresh(scan);
        return Effect.runPromise(
          AtomRegistry.getResult(appAtomRegistry, scan, { suspendOnWaiting: true }),
        );
      },
      async () => {
        const result = await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.create,
          {
            environmentId: job.environmentId,
            input: {
              projectId: job.projectId,
              commandId: job.commandId,
              title: job.title,
              workspaceRoot: job.workspaceRoot,
              createWorkspaceRootIfMissing: job.createWorkspaceRootIfMissing,
              defaultModelSelection: null,
            },
          },
          { reportFailure: false },
        );
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        await persistImportedCatalog(job, {}, catalogPersistence);
      },
    );
  },
  importPage: async (job) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      agentSessionImport,
      {
        environmentId: job.environmentId,
        input: {
          ...job.options,
          projectId: job.projectId,
          expectedWorkspaceRoot: job.workspaceRoot,
          ...(job.cursor === undefined ? {} : { cursor: job.cursor }),
        },
      },
      { reportFailure: false },
    );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    await persistImportedCatalog(job, result.value, catalogPersistence);
    return result.value;
  },
});
export function useBackgroundImports() {
  return useSyncExternalStore(
    backgroundImports.subscribe,
    backgroundImports.getSnapshot,
    backgroundImports.getSnapshot,
  );
}
