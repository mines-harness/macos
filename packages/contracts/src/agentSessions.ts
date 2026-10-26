import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals([
  "claudeAgent",
  "codex",
  "opencode",
  "antigravity",
  "t3code",
]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export function isAgentSessionGeneratedContextTitle(title: string): boolean {
  return /^(?:<(?:external_codex_apps_open_page|recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context)(?:\s|>)|# AGENTS\.md instructions\b)/.test(
    title.trim(),
  );
}

const AgentSessionImportOptions = {
  sources: Schema.optional(Schema.Array(AgentSessionSource)),
  exportPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  cursor: Schema.optional(NonNegativeInt),
  sourceWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  threadKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
};

export const AgentSessionSourceReport = Schema.Struct({
  source: AgentSessionSource,
  status: Schema.Literals(["available", "partial", "unavailable", "unsupported", "failed"]),
  message: Schema.String,
});
export type AgentSessionSourceReport = typeof AgentSessionSourceReport.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct(AgentSessionImportOptions);
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionSourceSection = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  order: Schema.optional(NonNegativeInt),
});
export type AgentSessionSourceSection = typeof AgentSessionSourceSection.Type;

export const AgentSessionSourceProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type AgentSessionSourceProject = typeof AgentSessionSourceProject.Type;

export const AgentSessionThreadProvenance = Schema.Struct({
  sourceThreadId: Schema.optional(TrimmedNonEmptyString),
  sourceParentThreadId: Schema.optional(TrimmedNonEmptyString),
  sourceRootThreadId: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(Schema.Literals(["thread", "subagent"])),
  agentName: Schema.optional(TrimmedNonEmptyString),
  sourceProject: Schema.optional(Schema.NullOr(AgentSessionSourceProject)),
});
export type AgentSessionThreadProvenance = typeof AgentSessionThreadProvenance.Type;

export const AgentSessionThreadCandidate = Schema.Struct({
  ...AgentSessionThreadProvenance.fields,
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  source: AgentSessionSource,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  sourceSection: Schema.optional(AgentSessionSourceSection),
});
export type AgentSessionThreadCandidate = typeof AgentSessionThreadCandidate.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  sourceProject: Schema.optional(Schema.NullOr(AgentSessionSourceProject)),
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  sourceWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  workspaceAvailable: Schema.optional(Schema.Boolean),
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
  sourceSection: Schema.optional(AgentSessionSourceSection),
  threads: Schema.optional(Schema.Array(AgentSessionThreadCandidate)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
  sourceReports: Schema.optional(Schema.Array(AgentSessionSourceReport)),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  ...AgentSessionImportOptions,
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  sourceSection: Schema.optional(AgentSessionSourceSection),
  catalogThreads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...AgentSessionThreadProvenance.fields,
        threadId: ThreadId,
        parentThreadId: Schema.optional(ThreadId),
        rootThreadId: Schema.optional(ThreadId),
        title: TrimmedNonEmptyString,
        sourceSection: Schema.optional(AgentSessionSourceSection),
      }),
    ),
  ),
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  alreadyImportedCount: Schema.optional(NonNegativeInt),
  nativeContinuationCount: Schema.optional(NonNegativeInt),
  transcriptOnlyCount: Schema.optional(NonNegativeInt),
  partialCount: Schema.optional(NonNegativeInt),
  failedCount: Schema.optional(NonNegativeInt),
  unavailableCount: Schema.optional(NonNegativeInt),
  hasMore: Schema.optional(Schema.Boolean),
  nextCursor: Schema.optional(NonNegativeInt),
  sourceReports: Schema.optional(Schema.Array(AgentSessionSourceReport)),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
