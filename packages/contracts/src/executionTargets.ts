import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CloudProvider = Schema.Literals(["codex", "claude"]);
export type CloudProvider = typeof CloudProvider.Type;

const CloudId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const CloudPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(100_000));

export const CloudCapabilities = Schema.Struct({
  submit: Schema.Boolean,
  list: Schema.Boolean,
  followUp: Schema.Boolean,
  status: Schema.Boolean,
  diff: Schema.Boolean,
  apply: Schema.Boolean,
  transcript: Schema.Boolean,
  cancel: Schema.Boolean,
});
export type CloudCapabilities = typeof CloudCapabilities.Type;

export const CloudTarget = Schema.Struct({
  id: CloudId,
  provider: CloudProvider,
  instanceId: ProviderInstanceId,
  label: TrimmedNonEmptyString,
  executionLocation: Schema.Literal("provider-cloud"),
  bridgeStatus: Schema.Literals(["available", "unavailable"]),
  cliVersion: Schema.NullOr(Schema.String),
  capabilities: CloudCapabilities,
  reason: Schema.optional(Schema.String),
});
export type CloudTarget = typeof CloudTarget.Type;

export const CloudTaskStatus = Schema.Literals([
  "linked",
  "submitted",
  "submission-unknown",
  "running",
  "completed",
  "failed",
  "unknown",
]);
export type CloudTaskStatus = typeof CloudTaskStatus.Type;

export const CloudTask = Schema.Struct({
  id: CloudId,
  accountKey: Schema.optional(CloudId),
  targetId: CloudId,
  providerTaskId: Schema.optional(
    CloudId.check(Schema.isPattern(/^(?:task_|session_|cse_)[A-Za-z0-9_-]+$/)),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  status: CloudTaskStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  summary: Schema.optional(Schema.String),
});
export type CloudTask = typeof CloudTask.Type;

export const CloudSnapshot = Schema.Struct({
  checkedAt: Schema.optional(IsoDateTime),
  targets: Schema.Array(CloudTarget),
  tasks: Schema.Array(CloudTask),
});
export type CloudSnapshot = typeof CloudSnapshot.Type;

export const CloudSubmitInput = Schema.Struct({
  requestId: CloudId,
  targetId: CloudId,
  cwd: TrimmedNonEmptyString,
  prompt: CloudPrompt,
  environmentId: Schema.optional(CloudId),
  branch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type CloudSubmitInput = typeof CloudSubmitInput.Type;

export const CloudLinkInput = Schema.Struct({
  targetId: CloudId,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type CloudLinkInput = typeof CloudLinkInput.Type;

export const CloudTaskInput = Schema.Struct({ taskId: CloudId });
export type CloudTaskInput = typeof CloudTaskInput.Type;

export const CloudFollowUpInput = Schema.Struct({
  requestId: CloudId,
  taskId: CloudId,
  prompt: CloudPrompt,
});
export type CloudFollowUpInput = typeof CloudFollowUpInput.Type;

export const CloudRefreshInput = Schema.Struct({
  targetId: CloudId,
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type CloudRefreshInput = typeof CloudRefreshInput.Type;

export const CloudRefreshResult = Schema.Struct({
  tasks: Schema.Array(CloudTask),
  cursor: Schema.optional(Schema.String),
});
export type CloudRefreshResult = typeof CloudRefreshResult.Type;

export const CloudDiffInput = Schema.Struct({
  taskId: CloudId,
  attempt: PositiveInt.check(Schema.isLessThanOrEqualTo(4)),
});
export type CloudDiffInput = typeof CloudDiffInput.Type;

export const CloudDiffResult = Schema.Struct({
  taskId: CloudId,
  attempt: PositiveInt,
  text: Schema.String,
  digest: TrimmedNonEmptyString,
});
export type CloudDiffResult = typeof CloudDiffResult.Type;

export const CloudApplyInput = Schema.Struct({
  ...CloudDiffInput.fields,
  cwd: TrimmedNonEmptyString,
  reviewedDigest: TrimmedNonEmptyString,
});
export type CloudApplyInput = typeof CloudApplyInput.Type;

export const CloudApplyResult = Schema.Struct({ applied: Schema.Literal(true) });
export type CloudApplyResult = typeof CloudApplyResult.Type;

export class CloudOperationError extends Schema.TaggedError<CloudOperationError>()(
  "CloudOperationError",
  {
    reason: Schema.Literals([
      "unsupported",
      "target-unavailable",
      "invalid-input",
      "not-found",
      "diff-changed",
      "workspace-dirty",
      "command-failed",
      "output-invalid",
      "persistence-failed",
      "request-conflict",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This operation is not exposed by the provider's cloud CLI. Open the task with the provider.";
      case "target-unavailable":
        return "The signed-in native CLI for this cloud account is not available on this computer.";
      case "invalid-input":
        return "Check the cloud task URL, environment, and workspace directory.";
      case "not-found":
        return "This cloud account or task is no longer available.";
      case "diff-changed":
        return "The cloud diff changed. Review the latest diff before applying it.";
      case "workspace-dirty":
        return "Commit or stash local changes before applying the cloud diff.";
      case "command-failed":
        return "The provider CLI did not complete this operation. Check its sign-in and cloud access on this computer.";
      case "output-invalid":
        return "The provider CLI returned an unrecognized result. Open the task with the provider before retrying.";
      case "persistence-failed":
        return "Could not save the cloud task registry. Check the server's storage.";
      case "request-conflict":
        return "This request identifier has already been used for different input.";
    }
  }
}
