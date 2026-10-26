import type {
  EnvironmentId,
  MineTransferAcceptInput,
  MineTransferBeginInput,
  MineTransferChunk,
  MineTransferFinalizeInput,
  MineTransferIdInput,
  MineTransferPreflightInput,
  MineTransferPreflightResult,
  MineTransferPrepareInput,
  MineTransferReadChunkInput,
  MineTransferReceipt,
  MineTransferStatus,
  MineTransferWriteChunkInput,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";

export interface MineTransferClient {
  readonly preflight: (input: MineTransferPreflightInput) => Promise<MineTransferPreflightResult>;
  readonly prepare: (input: MineTransferPrepareInput) => Promise<MineTransferStatus>;
  readonly readChunk: (input: MineTransferReadChunkInput) => Promise<MineTransferChunk>;
  readonly begin: (input: MineTransferBeginInput) => Promise<MineTransferStatus>;
  readonly writeChunk: (input: MineTransferWriteChunkInput) => Promise<MineTransferStatus>;
  readonly accept: (input: MineTransferAcceptInput) => Promise<MineTransferReceipt>;
  readonly finalize: (input: MineTransferFinalizeInput) => Promise<MineTransferStatus>;
  readonly cancel: (input: MineTransferIdInput) => Promise<MineTransferStatus>;
}

export interface MineTransferProgress {
  readonly stage: "checking" | "pausing" | "copying" | "starting" | "finishing" | "complete";
  readonly copiedBytes: number;
  readonly totalBytes: number;
}

export interface MineTransferRequest {
  readonly transferId: string;
  readonly threadId: ThreadId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly continueActive: boolean;
}

function chunkBytes(data: string): number {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error("The source returned an invalid file chunk. Retry the transfer.");
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export async function transferMine(
  source: MineTransferClient,
  destination: MineTransferClient,
  input: MineTransferRequest,
  onProgress: (progress: MineTransferProgress) => void,
): Promise<MineTransferReceipt> {
  const progress = (stage: MineTransferProgress["stage"], copiedBytes = 0, totalBytes = 0) =>
    onProgress({ stage, copiedBytes, totalBytes });
  if (input.sourceEnvironmentId === input.destinationEnvironmentId)
    throw new Error("Choose another device for this mine.");
  progress("checking");
  const target = await destination.preflight({ modelSelection: input.modelSelection });
  if (target.environmentId !== input.destinationEnvironmentId)
    throw new Error("The destination device changed. Reconnect it before transferring.");
  progress("pausing");
  const prepared = await source.prepare({
    transferId: input.transferId,
    threadId: input.threadId,
    destinationEnvironmentId: target.environmentId,
  });
  const manifest = prepared.manifest;
  if (
    !manifest ||
    manifest.transferId !== input.transferId ||
    manifest.sourceThreadId !== input.threadId ||
    manifest.sourceEnvironmentId !== input.sourceEnvironmentId ||
    manifest.destinationEnvironmentId !== input.destinationEnvironmentId ||
    manifest.workspace.transferId !== input.transferId ||
    manifest.workspace.bundleBytes > target.maxBundleBytes
  )
    throw new Error("The saved transfer does not match these devices or exceeds the device limit.");
  const total = manifest.workspace.bundleBytes;
  const receiving = await destination.begin({ manifest });
  let receipt = receiving.receipt;
  if (receiving.status === "cancelled")
    throw new Error("This transfer was cancelled. Start a new transfer.");
  if (!receipt && receiving.status !== "accepting") {
    let offset = receiving.receivedBytes;
    if (offset < 0 || offset > total)
      throw new Error("The destination returned an invalid transfer position.");
    progress("copying", offset, total);
    while (offset < total) {
      const chunk = await source.readChunk({ transferId: input.transferId, offset });
      const size = chunkBytes(chunk.data);
      if (
        chunk.offset !== offset ||
        chunk.totalBytes !== total ||
        size > target.chunkBytes ||
        offset + size > total
      )
        throw new Error("The file transfer changed unexpectedly. Retry the saved transfer.");
      const written = await destination.writeChunk({
        transferId: input.transferId,
        offset,
        data: chunk.data,
      });
      if (written.receivedBytes !== offset + size)
        throw new Error("The destination did not acknowledge this file chunk. Retry the transfer.");
      offset = written.receivedBytes;
      progress("copying", offset, total);
    }
  }
  progress("starting", total, total);
  // Replaying accept also completes a continuation interrupted after its receipt was saved.
  receipt = await destination.accept({
    transferId: input.transferId,
    resume: input.continueActive && manifest.wasActive,
  });
  if (
    receipt.transferId !== input.transferId ||
    receipt.destinationEnvironmentId !== input.destinationEnvironmentId
  )
    throw new Error("The destination returned a receipt for a different transfer.");
  progress("finishing", total, total);
  await source.finalize({ transferId: input.transferId, receipt });
  progress("complete", total, total);
  return receipt;
}

export async function cancelMineTransfer(
  source: MineTransferClient,
  destination: MineTransferClient,
  transferId: string,
): Promise<void> {
  // A lost acceptance reply must never unlock the source while the destination may be running.
  const cancelled = await destination.cancel({ transferId });
  if (cancelled.status !== "cancelled")
    throw new Error("The destination may already be running. Retry the transfer to finish safely.");
  await source.cancel({ transferId });
}
