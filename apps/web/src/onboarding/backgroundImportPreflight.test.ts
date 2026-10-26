import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type AgentSessionScanResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { BackgroundImportJob } from "./backgroundImports.logic";
import { createProjectForRetainedHistory } from "./backgroundImportPreflight";

const job: BackgroundImportJob = {
  id: "opencode-studio",
  environmentId: EnvironmentId.make("local"),
  environmentLabel: "Computer",
  projectId: ProjectId.make("studio"),
  commandId: CommandId.make("studio-create"),
  title: "Studio",
  workspaceRoot: "/deleted/Studio",
  createWorkspaceRootIfMissing: true,
  projectReady: false,
  options: { sources: ["opencode"], threadKeys: ["retained-thread"] },
  status: "running",
  error: null,
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
};
const retained: AgentSessionScanResult = {
  scannedAt: "2026-10-26T00:00:00.000Z",
  candidates: [
    {
      path: job.workspaceRoot,
      title: "Studio",
      sources: ["opencode"],
      threadCount: 1,
      lastActiveAt: null,
      alreadyImported: false,
      workspaceAvailable: false,
      threads: [
        { key: "retained-thread", title: "History", source: "opencode", lastActiveAt: null },
      ],
    },
  ],
  truncated: false,
};

it("does not create a phantom workspace when selected history disappeared or none is selected", async () => {
  const create = vi.fn(async () => {});
  await expect(
    createProjectForRetainedHistory(job, async () => ({ ...retained, candidates: [] }), create),
  ).rejects.toThrow("Selected history is no longer available");
  await expect(
    createProjectForRetainedHistory(
      { ...job, options: { ...job.options, threadKeys: [] } },
      async () => retained,
      create,
    ),
  ).rejects.toThrow("Selected history is no longer available");
  await expect(
    createProjectForRetainedHistory(
      { ...job, options: { ...job.options, threadKeys: ["stale-thread"] } },
      async () => retained,
      create,
    ),
  ).rejects.toThrow("Selected history is no longer available");
  expect(create).not.toHaveBeenCalled();
});

it("permits real retained history when its original workspace and CLI are gone", async () => {
  const create = vi.fn(async () => {});
  await createProjectForRetainedHistory(job, async () => retained, create);
  expect(create).toHaveBeenCalledOnce();
});
