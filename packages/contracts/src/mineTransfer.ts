import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const MINE_TRANSFER_CHUNK_BYTES = 512 * 1024;
export const MINE_TRANSFER_MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
export const MineTransferId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{8,80}$/));
export const WorkspaceTransferOriginUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    if (/[\s\\?#]/.test(value)) return false;
    if (/^git@(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):[a-zA-Z0-9._~/-]+$/.test(value))
      return true;
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    if (!url.hostname || url.pathname.length <= 1 || url.password) return false;
    return url.protocol === "https:" ? !url.username : url.protocol === "ssh:";
  }),
);
export const WorkspaceTransferManifest = Schema.Struct({
  version: Schema.Literal(1),
  transferId: MineTransferId,
  repositoryId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourceHead: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  sourceBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  originUrl: Schema.optional(WorkspaceTransferOriginUrl),
  snapshotCommit: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  snapshotTree: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)),
  snapshotRef: Schema.String.check(Schema.isPattern(/^refs\/mines\/handoffs\/[a-zA-Z0-9-]{8,80}$/)),
  bundleSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bundleBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MINE_TRANSFER_MAX_BUNDLE_BYTES)),
});
export type WorkspaceTransferManifest = typeof WorkspaceTransferManifest.Type;
export const MineTransferManifest = Schema.Struct({
  version: Schema.Literal(1),
  transferId: MineTransferId,
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  projectTitle: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  history: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String.check(Schema.isMaxLength(128_000)),
    }),
  ).check(
    Schema.isMaxLength(2048),
    Schema.makeFilter(
      (history) =>
        history.reduce((total, message) => total + message.text.length, 0) <= 128_000 ||
        "Transfer history must fit within 128,000 characters.",
    ),
  ),
  wasActive: Schema.Boolean,
  workspace: WorkspaceTransferManifest,
});
export type MineTransferManifest = typeof MineTransferManifest.Type;
export const MineTransferReceipt = Schema.Struct({
  transferId: MineTransferId,
  destinationEnvironmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
});
export type MineTransferReceipt = typeof MineTransferReceipt.Type;
export const MineTransferStatus = Schema.Struct({
  transferId: MineTransferId,
  role: Schema.Literals(["source", "destination"]),
  status: Schema.Literals([
    "preparing",
    "prepared",
    "receiving",
    "accepting",
    "accepted",
    "finalized",
    "cancelled",
  ]),
  receivedBytes: NonNegativeInt,
  manifest: Schema.optional(MineTransferManifest),
  receipt: Schema.optional(MineTransferReceipt),
});
export type MineTransferStatus = typeof MineTransferStatus.Type;
export const MineTransferPreflightInput = Schema.Struct({ modelSelection: ModelSelection });
export type MineTransferPreflightInput = typeof MineTransferPreflightInput.Type;
export const MineTransferPreflightResult = Schema.Struct({
  environmentId: EnvironmentId,
  maxBundleBytes: PositiveInt,
  chunkBytes: PositiveInt,
});
export type MineTransferPreflightResult = typeof MineTransferPreflightResult.Type;
export const MineTransferPrepareInput = Schema.Struct({
  transferId: MineTransferId,
  threadId: ThreadId,
  destinationEnvironmentId: EnvironmentId,
});
export type MineTransferPrepareInput = typeof MineTransferPrepareInput.Type;
export const MineTransferIdInput = Schema.Struct({ transferId: MineTransferId });
export type MineTransferIdInput = typeof MineTransferIdInput.Type;
export const MineTransferReadChunkInput = Schema.Struct({
  transferId: MineTransferId,
  offset: NonNegativeInt,
});
export type MineTransferReadChunkInput = typeof MineTransferReadChunkInput.Type;
export const MineTransferChunk = Schema.Struct({
  offset: NonNegativeInt,
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(MINE_TRANSFER_CHUNK_BYTES / 3) * 4)),
  totalBytes: NonNegativeInt,
});
export type MineTransferChunk = typeof MineTransferChunk.Type;
export const MineTransferBeginInput = Schema.Struct({ manifest: MineTransferManifest });
export type MineTransferBeginInput = typeof MineTransferBeginInput.Type;
export const MineTransferWriteChunkInput = Schema.Struct({
  transferId: MineTransferId,
  offset: NonNegativeInt,
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(MINE_TRANSFER_CHUNK_BYTES / 3) * 4)),
});
export type MineTransferWriteChunkInput = typeof MineTransferWriteChunkInput.Type;
export const MineTransferAcceptInput = Schema.Struct({
  transferId: MineTransferId,
  resume: Schema.Boolean,
});
export type MineTransferAcceptInput = typeof MineTransferAcceptInput.Type;
export const MineTransferFinalizeInput = Schema.Struct({
  transferId: MineTransferId,
  receipt: MineTransferReceipt,
});
export type MineTransferFinalizeInput = typeof MineTransferFinalizeInput.Type;
export class MineTransferError extends Schema.TaggedError<MineTransferError>()(
  "MineTransferError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "unsupported",
      "attachments-unsupported",
      "provider-unavailable",
      "invalid-data",
      "busy",
      "io",
    ]),
    transferId: Schema.optional(MineTransferId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-unavailable":
        return "Sign in to the same provider and enable this model on the destination device before transferring.";
      case "busy":
        return "The mine is still stopping, or another workflow is using its checkout. Wait a moment and retry.";
      case "attachments-unsupported":
        return "This mine includes conversation attachments. Device transfer currently supports text history and Git files. Start a text-only mine or transfer these attachments manually before continuing.";
      case "unsupported":
        return "This mine cannot be transferred yet. Groups, delegated work, unsupported repositories, Git bundles over 128 MiB, and conversations over 128,000 characters need a manual handoff.";
      case "invalid-data":
        return "The transfer data is incomplete or failed validation. Retry the transfer.";
      case "not-found":
        return "This transfer could not be found on the device.";
      case "conflict":
        return "This transfer has changed state. Retry to recover its current state.";
      case "io":
        return "The device could not save or read the transfer. Check its connection and available storage, then retry.";
    }
  }
}
