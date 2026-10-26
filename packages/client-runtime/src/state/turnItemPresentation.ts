import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructureTurnItem } from "./models.ts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";
const importTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function threadImportLabel(
  input: {
    readonly historyOrigin?: string | undefined;
    readonly importedAt?: DateTime.Utc | undefined;
  },
  locales?: Intl.LocalesArgument,
): string | null {
  if (input.historyOrigin !== "v1_import") return null;
  if (input.importedAt === undefined) return "Thread imported";
  const formatter =
    locales === undefined
      ? importTimeFormatter
      : new Intl.DateTimeFormat(locales, {
          dateStyle: "medium",
          timeStyle: "short",
        });
  return `Thread imported on ${formatter.format(DateTime.toDateUtc(input.importedAt))}`;
}

export function threadImportBoundaryItemId(
  items: ReadonlyArray<Pick<OrchestrationV2ProjectedTurnItem, "sourceThreadId" | "sourceItemId">>,
  threadId: ThreadId,
): TurnItemId | null {
  const prefix = `agent-session-import:v2:turn-item:${threadId}:`;
  return (
    items.findLast(
      (row) =>
        row.sourceThreadId === threadId &&
        row.sourceItemId.startsWith(prefix) &&
        /^\d{6,}$/.test(row.sourceItemId.slice(prefix.length)),
    )?.sourceItemId ?? null
  );
}

export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return (
    (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
    (item.type === "error" &&
      item.status === "cancelled" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE)
  );
}

export function workspacePreparationRetryRunIds(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "workspacePreparation">>,
  items: ReadonlyArray<ThreadStructureTurnItem>,
): ReadonlySet<OrchestrationV2Run["id"]> {
  const failedRuns = new Set(
    runs.flatMap((run) =>
      run.status === "failed" && run.workspacePreparation !== undefined ? [run.id] : [],
    ),
  );
  const retryable = new Set<OrchestrationV2Run["id"]>();
  if (failedRuns.size === 0) return retryable;
  for (const item of items) {
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
      item.runId !== null &&
      failedRuns.has(item.runId)
    )
      retryable.add(item.runId);
  }
  return retryable;
}
